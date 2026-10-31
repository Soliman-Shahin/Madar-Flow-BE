import { beforeAll, afterAll, afterEach } from '@jest/globals';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import crypto from 'crypto';

// Tests must never read the developer's real Madar-Flow-BE/.env (real DB URI, mail and Firebase
// credentials). dotenv is stubbed, and every variable the app needs gets a throwaway value.
jest.mock('dotenv', () => {
  const config = () => ({ parsed: {} });
  return { __esModule: true, default: { config }, config };
});

const throwaway = () => crypto.randomBytes(24).toString('hex');
const testEnv: Record<string, string> = {
  ACCESS_TOKEN_SECRET: throwaway(),
  REFRESH_TOKEN_SECRET: throwaway(),
  JWT_SECRET: throwaway(),
  ENCRYPTION_KEY: throwaway(),
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  // External services stay disabled: no real mail, push or payments from tests.
  RESEND_API_KEY: '',
  RESEND_FROM_EMAIL: '',
  FIREBASE_PROJECT_ID: '',
  FIREBASE_CLIENT_EMAIL: '',
  FIREBASE_PRIVATE_KEY: '',
};
for (const [key, value] of Object.entries(testEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  // Start the in-memory MongoDB instance
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  // Connect Mongoose to the in-memory instance
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  // Disconnect and stop the in-memory instance
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});

afterEach(async () => {
  // Clear all data between tests to ensure test isolation
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany({});
  }
});
