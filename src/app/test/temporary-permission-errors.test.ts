import request from 'supertest';
import { configureExpressApp } from '../app';
import { User, UserRole } from '../models/user.model';

const app = configureExpressApp();

async function admin(email: string) {
  const user = await User.create({ email, password: 'not-used', role: UserRole.Admin });
  await user.createSession();
  return { id: String(user._id), token: await (await User.findById(user._id))!.generateAccessAuthToken() };
}
const iso = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

describe('temporary permission business-rule errors are client errors', () => {
  it('rejects bad dates, unknown ids and double revocation with 4xx instead of 500', async () => {
    const a = await admin('tp-admin@example.test');
    const auth = { Authorization: `Bearer ${a.token}` };

    const badDates = await request(app).post('/v1/temporary-permissions').set(auth)
      .send({ userId: a.id, permission: 'expense:export', startDate: iso(2), endDate: iso(1), reason: 'qa' });
    expect(badDates.status).toBe(400);

    const created = await request(app).post('/v1/temporary-permissions').set(auth)
      .send({ userId: a.id, permission: 'expense:export', startDate: iso(-0.01), endDate: iso(1), reason: 'qa' });
    expect(created.status).toBe(201);
    const id = created.body.data._id;

    const notLater = await request(app).patch(`/v1/temporary-permissions/${id}/extend`).set(auth)
      .send({ newEndDate: iso(0.5), reason: 'qa' });
    expect(notLater.status).toBe(400);

    const unknown = await request(app).patch('/v1/temporary-permissions/507f1f77bcf86cd799439099/extend').set(auth)
      .send({ newEndDate: iso(3), reason: 'qa' });
    expect(unknown.status).toBe(404);

    expect((await request(app).delete(`/v1/temporary-permissions/${id}`).set(auth).send({ reason: 'qa' })).status).toBe(200);
    const again = await request(app).delete(`/v1/temporary-permissions/${id}`).set(auth).send({ reason: 'qa' });
    expect(again.status).toBe(409);
  });
});
