import request from 'supertest';
import { configureExpressApp } from '../app';
import { User, UserRole } from '../models/user.model';

const app = configureExpressApp();
const MISSING = '507f1f77bcf86cd799439099';

async function staffToken(role: UserRole, email: string) {
  const user = await User.create({ email, password: 'not-used', role });
  await user.createSession();
  return (await User.findById(user._id))!.generateAccessAuthToken();
}

describe('admin detail endpoints for unknown ids', () => {
  it.each(['users', 'categories', 'expenses'])('GET /v1/admin/%s/:id answers 404, not 500', async (resource) => {
    const token = await staffToken(UserRole.Moderator, `nf-${resource}@example.test`);
    const res = await request(app).get(`/v1/admin/${resource}/${MISSING}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('still answers 400 for a malformed id', async () => {
    const token = await staffToken(UserRole.Moderator, 'nf-malformed@example.test');
    const res = await request(app).get('/v1/admin/users/xyz').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe('admin category deletion rules', () => {
  it('answers 409 (not 500) when deleting a system default category', async () => {
    const { Category } = await import('../models/category.model');
    const token = await staffToken(UserRole.Admin, 'default-cat-admin@example.test');
    const owner = await User.create({ email: 'default-cat-owner@example.test', password: 'not-used' });
    const cat = await Category.create({ user: owner._id, title: 'Default', icon: 'folder', color: '#111111', isDefault: true, _clientId: 'default-cat-1' });
    const res = await request(app).delete(`/v1/admin/categories/${cat._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('categories created by an admin are not system defaults and can be deleted (D-019)', async () => {
    const token = await staffToken(UserRole.Admin, 'created-cat-admin@example.test');
    const created = await request(app)
      .post('/v1/admin/categories')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Admin made', icon: 'cart-outline', color: '#3366CC', type: 'outcome' });
    expect(created.status).toBe(201);
    expect(created.body.data.isDefault).toBe(false);
    const del = await request(app)
      .delete(`/v1/admin/categories/${created.body.data._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
  });
});
