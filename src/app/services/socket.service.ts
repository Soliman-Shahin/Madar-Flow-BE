import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import logger from './logger.service';
import jwt from 'jsonwebtoken';
import { corsOptions } from '../config/corsConfig';
import { User } from '../models/user.model';

export interface RichNotification {
  id?: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warn' | 'error';
  isRead?: boolean;
  createdAt?: string | Date;
  actor?: { id?: string; email?: string; role?: string };
  action?: string;
  resource?: { type?: string; id?: string; name?: string };
  changes?: Record<string, any>;
  auditLogId?: string;
}

export class SocketService {
  private io: Server;

  constructor(server: HttpServer) {
    this.io = new Server(server, {
      cors: corsOptions,
    });

    this.initialize();
  }

  private initialize() {
    // Middleware for authentication
    this.io.use((socket, next) => {
      void this.authenticate(socket, next);
    });

    this.io.on('connection', (socket: Socket) => {
      logger.info(`[Socket.io] Client connected: ${socket.id}`);

      // We can join rooms based on role if needed
      const user = (socket as any).user;
      if (user && user.role) {
        socket.join(user.role);
        logger.info(
          `[Socket.io] User ${user.id} joined role room: ${user.role}`
        );
      }
      if (user && user.id) socket.join(`user:${String(user.id)}`);

      socket.on('disconnect', () => {
        logger.info(`[Socket.io] Client disconnected: ${socket.id}`);
      });
    });
  }

  /**
   * Same trust rules as the HTTP access middleware: a valid JWT is not enough, the account must
   * still be active and the session id must still be live. Role comes from the database because
   * access tokens only carry { _id, sid }.
   */
  private async authenticate(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token;
    if (!token || typeof token !== 'string') {
      return next(new Error('Authentication error: Token missing'));
    }
    try {
      const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET as string, {
        algorithms: ['HS256'],
      }) as any;
      if (typeof payload?._id !== 'string' || typeof payload?.sid !== 'string') {
        throw new Error('bad payload');
      }
      const doc = await User.findById(payload._id)
        .select('isActive _isDeleted role sessions')
        .lean();
      const now = Math.floor(Date.now() / 1000);
      const live =
        doc &&
        !doc._isDeleted &&
        doc.isActive !== false &&
        doc.sessions?.some((session) => session.sessionId === payload.sid && session.expiresAt > now);
      if (!live) throw new Error('inactive');
      (socket as any).user = { id: String(doc!._id), role: doc!.role };
      next();
    } catch {
      next(new Error('Authentication error: Invalid token'));
    }
  }

  // Method to broadcast a notification to all connected clients
  // or specific roles
  public broadcastNotification(notification: RichNotification, role?: string) {
    const enrichedNotification = {
      ...notification,
      id: notification.id || crypto.randomUUID(),
      isRead: false,
      createdAt: notification.createdAt || new Date(),
    };

    if (role && role !== 'all') {
      this.io.to(role).emit('ReceiveNotification', enrichedNotification);
    } else {
      this.io.emit('ReceiveNotification', enrichedNotification);
    }
    logger.info(`[Socket.io] Broadcasted notification: ${notification.title}`);
  }

  /** Operational/audit events: only staff dashboards should ever see them. */
  public broadcastToStaff(notification: RichNotification) {
    for (const role of ['moderator', 'admin', 'superadmin']) {
      this.broadcastNotification(notification, role);
    }
  }

  public sendNotificationToUser(
    userId: string,
    notification: RichNotification
  ) {
    const enrichedNotification = {
      ...notification,
      id: notification.id || crypto.randomUUID(),
      isRead: false,
      createdAt: notification.createdAt || new Date(),
    };
    this.io
      .to(`user:${userId}`)
      .emit('ReceiveNotification', enrichedNotification);
  }

  public disconnectUser(userId: string) {
    this.io.in(`user:${userId}`).disconnectSockets(true);
  }

  /** Disconnects every client and closes the underlying HTTP server. */
  public close(): Promise<void> {
    return new Promise((resolve) => this.io.close(() => resolve()));
  }
}

// We will initialize this in server.ts and export a getter if needed
let socketServiceInstance: SocketService | null = null;

export const initializeSocketService = (server: HttpServer) => {
  socketServiceInstance = new SocketService(server);
  return socketServiceInstance;
};

export const getSocketService = () => {
  if (!socketServiceInstance) {
    throw new Error('SocketService is not initialized');
  }
  return socketServiceInstance;
};
