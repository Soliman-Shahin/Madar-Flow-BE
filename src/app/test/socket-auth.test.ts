import http from 'http';
import { SocketService } from '../services/socket.service';
import { ExpenseService } from '../services/expense.service';
import * as socketModule from '../services/socket.service';
import { Category, User } from '../models';

let server: http.Server;
let service: SocketService;

beforeAll(() => {
  server = http.createServer();
  service = new SocketService(server);
});
afterAll(async () => {
  await service.close();
});

async function userWithToken(role: string, tag: string) {
  const user = await User.create({ email: `sock-${tag}-${Date.now()}@example.test`, password: 'not-used', role } as any);
  await user.createSession();
  const token = await (await User.findById(user._id))!.generateAccessAuthToken();
  return { user, token };
}
const handshake = (token?: unknown) => ({ handshake: { auth: { token } } }) as any;
const run = (socket: any) =>
  new Promise<Error | undefined>((resolve) => (service as any).authenticate(socket, (err?: Error) => resolve(err)));

describe('socket handshake', () => {
  it('rejects a missing, malformed or forged token', async () => {
    expect((await run(handshake()))?.message).toMatch(/Token missing/);
    expect((await run(handshake(12345)))?.message).toMatch(/Token missing/);
    expect((await run(handshake('not.a.jwt')))?.message).toMatch(/Invalid token/);
  });

  it('accepts a live session and takes the role from the database', async () => {
    const { token, user } = await userWithToken('moderator', 'live');
    const socket = handshake(token);
    expect(await run(socket)).toBeUndefined();
    expect(socket.user).toEqual({ id: user._id.toString(), role: 'moderator' });
  });

  it('rejects a valid JWT once the session is gone, the account is deactivated or deleted', async () => {
    const revoked = await userWithToken('user', 'revoked');
    await User.updateOne({ _id: revoked.user._id }, { $set: { sessions: [] } });
    expect((await run(handshake(revoked.token)))?.message).toMatch(/Invalid token/);

    const inactive = await userWithToken('user', 'inactive');
    await User.updateOne({ _id: inactive.user._id }, { $set: { isActive: false } });
    expect((await run(handshake(inactive.token)))?.message).toMatch(/Invalid token/);

    const deleted = await userWithToken('user', 'deleted');
    await User.updateOne({ _id: deleted.user._id }, { $set: { _isDeleted: true } });
    expect((await run(handshake(deleted.token)))?.message).toMatch(/Invalid token/);
  });

  it('joins the personal and role rooms (previously empty: the token has no id/role claims)', async () => {
    const { token, user } = await userWithToken('admin', 'rooms');
    const socket: any = handshake(token);
    await run(socket);
    const joined: string[] = [];
    socket.join = (room: string) => joined.push(room);
    socket.on = jest.fn();
    socket.id = 'fake';
    (service as any).io.of('/').listeners('connection').forEach((l: any) => l(socket));
    expect(joined).toEqual(expect.arrayContaining(['admin', `user:${user._id.toString()}`]));
  });
});

describe('realtime audience', () => {
  it('audit events go to staff rooms only, never to every connected socket', async () => {
    const io = (service as any).io;
    const emit = jest.spyOn(io, 'emit');
    const to = jest.spyOn(io, 'to').mockReturnValue({ emit: jest.fn() } as any);
    service.broadcastToStaff({ title: 't', message: 'm', type: 'info' });
    expect(emit).not.toHaveBeenCalled();
    expect(to.mock.calls.map((c) => c[0])).toEqual(['moderator', 'admin', 'superadmin']);
    emit.mockRestore();
    to.mockRestore();
  });

  it("an expense write does not broadcast the owner's data to all sockets", async () => {
    const { user } = await userWithToken('user', 'owner');
    const category = await Category.create({ user: user._id, _clientId: `sock-cat-${Date.now()}`, title: 'c', icon: 'x', color: '#000000' });
    const fake = { broadcastNotification: jest.fn(), broadcastToStaff: jest.fn() };
    const spy = jest.spyOn(socketModule, 'getSocketService').mockReturnValue(fake as any);
    await ExpenseService.createExpense(
      { description: 'private lunch', amount: 7, category: category._id.toString(), date: new Date() },
      user._id.toString()
    );
    expect(fake.broadcastNotification).not.toHaveBeenCalled();
    expect(fake.broadcastToStaff).toHaveBeenCalled();
    spy.mockRestore();
  });
});
