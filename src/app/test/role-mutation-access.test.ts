import request from 'supertest';
import { configureExpressApp } from '../app';
import { User, UserRole } from '../models/user.model';
import { Role } from '../models/role.model';
import { Permission } from '../types/permissions.types';
import { planService } from '../services/plan.service';

const app = configureExpressApp();

async function as(role: UserRole, email: string) {
  const user = await User.create({ email, password: 'not-used', role });
  await user.createSession();
  return { Authorization: `Bearer ${await (await User.findById(user._id))!.generateAccessAuthToken()}` };
}
const body = (slug: string) => ({ name: 'QA role', slug, description: 'x', permissions: [] });

let moderatorRoleId: string;
beforeEach(async () => {
  await planService.seedDefaultPlans();
  // Staff permissions come from Role documents (see PlanService.getUserPlanContext).
  const mod = await Role.create({ name: 'Moderator', slug: 'moderator', permissions: [Permission.ADMIN_USERS], isSystem: true });
  await Role.create({ name: 'Admin', slug: 'admin', permissions: [Permission.ADMIN_USERS], isSystem: true });
  await Role.create({ name: 'SuperAdmin', slug: 'superadmin', permissions: [Permission.ADMIN_USERS], isSystem: true });
  moderatorRoleId = String(mod._id);
});

describe('role definitions: read for moderators, write for Admin+ (D-014)', () => {
  it('lets a moderator read but not create, update or delete roles', async () => {
    const mod = await as(UserRole.Moderator, 'role-mod@example.test');
    expect((await request(app).get('/v1/roles').set(mod)).status).toBe(200);
    expect((await request(app).post('/v1/roles').set(mod).send(body('mod-role'))).status).toBe(403);
    expect((await request(app).put(`/v1/roles/${moderatorRoleId}`).set(mod).send({ name: 'x1' })).status).toBe(403);
    expect((await request(app).delete('/v1/roles/507f1f77bcf86cd799439011').set(mod)).status).toBe(403);
  });

  it('prevents a moderator from granting their own role more permissions (privilege escalation)', async () => {
    const mod = await as(UserRole.Moderator, 'role-escalate@example.test');
    const res = await request(app)
      .put(`/v1/roles/${moderatorRoleId}`)
      .set(mod)
      .send({ permissions: Object.values(Permission) });
    expect(res.status).toBe(403);
    const stored = await Role.findById(moderatorRoleId).lean();
    expect(stored!.permissions).toEqual([Permission.ADMIN_USERS]);
  });

  it('lets an admin create, update and delete a role', async () => {
    const admin = await as(UserRole.Admin, 'role-admin@example.test');
    const created = await request(app).post('/v1/roles').set(admin).send(body('admin-role'));
    expect(created.status).toBeLessThan(300);
    const id = created.body.data._id;
    expect((await request(app).put(`/v1/roles/${id}`).set(admin).send({ name: 'QA role 2' })).status).toBe(200);
    expect((await request(app).delete(`/v1/roles/${id}`).set(admin)).status).toBe(200);
  });

  it('keeps consumers out entirely', async () => {
    const user = await as(UserRole.User, 'role-user@example.test');
    expect((await request(app).get('/v1/roles').set(user)).status).toBe(403);
  });
});

describe('system roles are protected from Admin (D-021)', () => {
  it('stops an admin from granting their own system role extra permissions', async () => {
    const admin = await as(UserRole.Admin, 'sys-admin@example.test');
    const adminRole = await Role.findOne({ slug: 'admin' });
    const res = await request(app)
      .put(`/v1/roles/${adminRole!._id}`)
      .set(admin)
      .send({ permissions: Object.values(Permission) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SYSTEM_ROLE_PROTECTED');
    expect((await Role.findById(adminRole!._id).lean())!.permissions).toEqual([Permission.ADMIN_USERS]);
  });

  it('stops an admin deleting a system role or creating one flagged isSystem', async () => {
    const admin = await as(UserRole.Admin, 'sys-admin2@example.test');
    const adminRole = await Role.findOne({ slug: 'admin' });
    expect((await request(app).delete(`/v1/roles/${adminRole!._id}`).set(admin)).status).toBe(403);
    const flagged = await request(app).post('/v1/roles').set(admin).send({ ...body('sneaky'), isSystem: true });
    expect(flagged.status).toBe(403);
  });

  it('does not let an admin turn a custom role into a system role through an update', async () => {
    const admin = await as(UserRole.Admin, 'sys-admin3@example.test');
    const created = await request(app).post('/v1/roles').set(admin).send(body('custom-one'));
    const id = created.body.data._id;
    const res = await request(app).put(`/v1/roles/${id}`).set(admin).send({ name: 'Custom two', isSystem: true });
    expect(res.status).toBe(403);
    expect((await Role.findById(id).lean())!.isSystem).toBe(false);
  });

  it('lets a superadmin edit a system role', async () => {
    const superadmin = await as(UserRole.SuperAdmin, 'sys-super@example.test');
    const adminRole = await Role.findOne({ slug: 'admin' });
    const res = await request(app).put(`/v1/roles/${adminRole!._id}`).set(superadmin).send({ description: 'updated by superadmin' });
    expect(res.status).toBe(200);
  });
});
