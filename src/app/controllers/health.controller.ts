import { Request, Response } from 'express';
import { sendSuccess, sendError } from '../shared/helper';
import mongoose from 'mongoose';

/**
 * Health Check Controller
 *
 * Provides health and readiness checks for the application
 */

interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  uptime: number;
  version: string;
  environment: string;
  checks: {
    database: HealthCheckResult;
    memory: HealthCheckResult;
    // Add more checks as needed
  };
}

interface HealthCheckResult {
  status: 'pass' | 'fail' | 'warn';
  message?: string;
  responseTime?: number;
  details?: any;
}

/**
 * Check database health
 */
async function checkDatabase(): Promise<HealthCheckResult> {
  const startTime = Date.now();

  try {
    const state = mongoose.connection.readyState;
    const responseTime = Date.now() - startTime;

    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const stateMap: Record<number, string> = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    };

    if (state === 1) {
      // Connected - perform a simple query to verify
      await mongoose.connection.db?.admin().ping();

      return {
        status: 'pass',
        message: 'Database connection is healthy',
        responseTime,
        details: {
          state: stateMap[state],
          host: mongoose.connection.host,
          name: mongoose.connection.name,
        },
      };
    } else {
      return {
        status: 'fail',
        message: `Database is ${stateMap[state] || 'unknown'}`,
        responseTime,
        details: {
          state: stateMap[state],
        },
      };
    }
  } catch (error: any) {
    return {
      status: 'fail',
      message: 'Database check failed',
      responseTime: Date.now() - startTime,
      details: {
        error: error.message,
      },
    };
  }
}

/**
 * Check memory usage
 */
function checkMemory(): HealthCheckResult {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  const heapUsagePercent = Math.round(
    (memUsage.heapUsed / memUsage.heapTotal) * 100
  );

  // Warn if using more than 80% of heap
  const status = heapUsagePercent > 80 ? 'warn' : 'pass';
  const message =
    status === 'warn'
      ? `High memory usage: ${heapUsagePercent}%`
      : 'Memory usage is healthy';

  return {
    status,
    message,
    details: {
      heapUsed: `${heapUsedMB} MB`,
      heapTotal: `${heapTotalMB} MB`,
      heapUsagePercent: `${heapUsagePercent}%`,
      rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)} MB`,
    },
  };
}

/**
 * Perform all health checks
 */
async function performHealthChecks(): Promise<HealthStatus> {
  const checks = {
    database: await checkDatabase(),
    memory: checkMemory(),
  };

  // Determine overall status
  let status: HealthStatus['status'] = 'healthy';

  if (Object.values(checks).some((check) => check.status === 'fail')) {
    status = 'unhealthy';
  } else if (Object.values(checks).some((check) => check.status === 'warn')) {
    status = 'degraded';
  }

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks,
  };
}

/**
 * Basic health check endpoint (lightweight)
 * GET /health
 */
export const basicHealthCheck = async (req: Request, res: Response) => {
  try {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    };

    return res.status(200).json(health);
  } catch (error: any) {
    return res.status(503).json({
      status: 'error',
      message: error.message,
    });
  }
};

/**
 * Public health summary used by clients (the Mobile app polls it to detect backend reachability).
 * It exposes only the overall status: no version, environment, timings or memory details.
 * GET /health/detailed
 */
export const detailedHealthCheck = async (req: Request, res: Response) => {
  try {
    const health = await performHealthChecks();
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    return res.status(statusCode).json({ status: health.status, timestamp: health.timestamp });
  } catch (error: any) {
    return sendError(res, 'Health check failed', 500, 'HEALTH_CHECK_FAILED');
  }
};

/**
 * Full diagnostics (version, environment, database timing, memory). Staff only.
 * GET /health/diagnostics
 */
export const diagnosticsHealthCheck = async (req: Request, res: Response) => {
  try {
    const health = await performHealthChecks();
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    return res.status(statusCode).json(health);
  } catch (error: any) {
    return sendError(res, error.message, 500, 'HEALTH_CHECK_FAILED');
  }
};

/**
 * Readiness check (for Kubernetes/orchestration)
 * GET /health/ready
 */
export const readinessCheck = async (req: Request, res: Response) => {
  try {
    const dbCheck = await checkDatabase();

    if (dbCheck.status === 'pass') {
      return res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString(),
      });
    } else {
      return res.status(503).json({
        status: 'not ready',
        reason: dbCheck.message,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    return res.status(503).json({
      status: 'not ready',
      reason: error.message,
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * Liveness check (for Kubernetes/orchestration)
 * GET /health/live
 */
export const livenessCheck = async (req: Request, res: Response) => {
  // Simple check that the process is alive
  return res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
};

export default {
  basicHealthCheck,
  detailedHealthCheck,
  diagnosticsHealthCheck,
  readinessCheck,
  livenessCheck,
};
