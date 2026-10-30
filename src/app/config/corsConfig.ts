import logger from '../services/logger.service';
// Allow overriding origins from environment variable (comma-separated)
const envOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const defaultOrigins = [
  'http://localhost', // Android WebView default origin
  'https://localhost', // Capacitor Android when androidScheme is 'https'
  'http://localhost:4200',
  'http://localhost:4300',
  'http://localhost:4400',
  'http://localhost:8200',
  'http://localhost:8100',
  'http://127.0.0.1:51802',
  // Ionic/Capacitor mobile webview origins
  'capacitor://localhost',
  'ionic://localhost',
  'https://expenses-wallet.up.railway.app', // API itself (not typically needed but safe)
  'https://expenses-wallet-admin.up.railway.app',
];

const allowedOrigins = Array.from(new Set([...defaultOrigins, ...envOrigins]));

export const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    // Allow server-to-server or non-browser requests (no origin)
    if (!origin) return callback(null, true);

    // Fast path: explicit allow-list
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow any localhost with optional port and either http or https
    try {
      const url = new URL(origin);
      const isLocalhost =
        (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
        (url.protocol === 'http:' || url.protocol === 'https:');
      if (isLocalhost) {
        return callback(null, true);
      }
    } catch (_) {
      // Non-standard schemes like capacitor://localhost won't parse via URL
      // Handle them explicitly below
    }

    // Allow common Capacitor/Ionic schemes explicitly
    if (origin === 'capacitor://localhost' || origin === 'ionic://localhost') {
      return callback(null, true);
    }

    // Temporary debug log to identify unexpected origins in production
    logger.warn(`[CORS] Blocked origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'access-token',
    'refresh-token',
    '_id',
    'X-Requested-With',
    'X-Skip-Retry',
    'X-Silent-Error',
    'X-Auth-Transport',
    'X-Client-Platform',
    'X-Auth-Persistence',
    'X-Auth-Cookie-Path',
    'X-CSRF-Token',
    'X-Auth-Retry',
  ],
  exposedHeaders: ['access-token', 'refresh-token', '_id'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};
