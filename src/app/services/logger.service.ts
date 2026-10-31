import { Request } from 'express';

/**
 * Advanced Logger Service
 *
 * Features:
 * - Multiple log levels
 * - Structured logging
 * - Request context tracking
 * - Performance metrics
 * - Error tracking
 * - Production-ready formatting
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

export interface LogContext {
  requestId?: string;
  userId?: string;
  ip?: string;
  method?: string;
  path?: string;
  userAgent?: string;
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  duration?: number;
  metadata?: any;
}

class Logger {
  private minLevel: LogLevel;
  private isProduction: boolean;

  constructor() {
    this.isProduction = process.env.NODE_ENV === 'production';
    this.minLevel = this.isProduction ? LogLevel.INFO : LogLevel.DEBUG;
  }

  /**
   * Create log entry
   */
  private createLogEntry(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error,
    metadata?: any
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level],
      message,
    };

    if (context && Object.keys(context).length > 0) {
      entry.context = context;
    }

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        code: (error as any).code,
      };

      // Include stack trace in non-production
      if (!this.isProduction) {
        entry.error.stack = error.stack;
      }
    }

    if (metadata) {
      entry.metadata = metadata;
    }

    return entry;
  }

  /**
   * Format log entry for console output
   */
  private formatLogEntry(entry: LogEntry): string {
    if (this.isProduction) {
      // JSON format for production (easy parsing)
      return JSON.stringify(entry);
    } else {
      // Human-readable format for development
      const emoji = this.getLevelEmoji(entry.level);
      let output = `${emoji} [${entry.timestamp}] ${entry.level}: ${entry.message}`;

      if (entry.context) {
        output += `\n  Context: ${JSON.stringify(entry.context, null, 2)}`;
      }

      if (entry.error) {
        output += `\n  Error: ${entry.error.name} - ${entry.error.message}`;
        if (entry.error.stack) {
          output += `\n  Stack: ${entry.error.stack}`;
        }
      }

      if (entry.metadata) {
        output += `\n  Metadata: ${JSON.stringify(entry.metadata, null, 2)}`;
      }

      if (entry.duration) {
        output += `\n  Duration: ${entry.duration}ms`;
      }

      return output;
    }
  }

  /**
   * Get emoji for log level (development only)
   */
  private getLevelEmoji(level: string): string {
    const emojis: Record<string, string> = {
      DEBUG: '🔍',
      INFO: 'ℹ️',
      WARN: '⚠️',
      ERROR: '❌',
      FATAL: '💀',
    };
    return emojis[level] || 'ℹ️';
  }

  /**
   * Write log to console
   */
  private write(entry: LogEntry): void {
    const formatted = this.formatLogEntry(entry);
    const level = LogLevel[entry.level as keyof typeof LogLevel];

    if (level >= this.minLevel) {
      if (level >= LogLevel.ERROR) {
        console.error(formatted);
      } else if (level >= LogLevel.WARN) {
        console.warn(formatted);
      } else {
        console.log(formatted);
      }
    }
  }

  /**
   * Debug log
   */
  public debug(message: string, context?: LogContext, metadata?: any): void {
    const entry = this.createLogEntry(
      LogLevel.DEBUG,
      message,
      context,
      undefined,
      metadata
    );
    this.write(entry);
  }

  /**
   * Info log
   */
  public info(message: string, context?: LogContext, metadata?: any): void {
    const entry = this.createLogEntry(
      LogLevel.INFO,
      message,
      context,
      undefined,
      metadata
    );
    this.write(entry);
  }

  /**
   * Warning log
   */
  public warn(message: string, context?: LogContext, metadata?: any): void {
    const entry = this.createLogEntry(
      LogLevel.WARN,
      message,
      context,
      undefined,
      metadata
    );
    this.write(entry);
  }

  /**
   * Error log
   */
  public error(
    message: string,
    error?: Error,
    context?: LogContext,
    metadata?: any
  ): void {
    const entry = this.createLogEntry(
      LogLevel.ERROR,
      message,
      context,
      error,
      metadata
    );
    this.write(entry);
  }

  /**
   * Fatal error log
   */
  public fatal(
    message: string,
    error?: Error,
    context?: LogContext,
    metadata?: any
  ): void {
    const entry = this.createLogEntry(
      LogLevel.FATAL,
      message,
      context,
      error,
      metadata
    );
    this.write(entry);
  }

  /**
   * Create logger with default context
   */
  public createLogger(defaultContext: LogContext): ContextLogger {
    return new ContextLogger(this, defaultContext);
  }

  /**
   * Extract request context
   */
  public static extractRequestContext(req: Request): LogContext {
    return {
      requestId: req.id || Math.random().toString(36).substr(2, 9),
      userId: req.user_id,
      ip: req.ip || req.socket.remoteAddress,
      method: req.method,
      path: req.path,
      userAgent: req.get('user-agent'),
    };
  }

  /**
   * Log request performance
   */
  public logPerformance(
    message: string,
    duration: number,
    context?: LogContext,
    metadata?: any
  ): void {
    const entry = this.createLogEntry(
      LogLevel.INFO,
      message,
      context,
      undefined,
      metadata
    );
    entry.duration = duration;
    this.write(entry);
  }
}

/**
 * Context logger - maintains default context for all logs
 */
class ContextLogger {
  constructor(
    private logger: Logger,
    private defaultContext: LogContext
  ) {}

  private mergeContext(context?: LogContext): LogContext {
    return { ...this.defaultContext, ...context };
  }

  public debug(message: string, context?: LogContext, metadata?: any): void {
    this.logger.debug(message, this.mergeContext(context), metadata);
  }

  public info(message: string, context?: LogContext, metadata?: any): void {
    this.logger.info(message, this.mergeContext(context), metadata);
  }

  public warn(message: string, context?: LogContext, metadata?: any): void {
    this.logger.warn(message, this.mergeContext(context), metadata);
  }

  public error(
    message: string,
    error?: Error,
    context?: LogContext,
    metadata?: any
  ): void {
    this.logger.error(message, error, this.mergeContext(context), metadata);
  }

  public fatal(
    message: string,
    error?: Error,
    context?: LogContext,
    metadata?: any
  ): void {
    this.logger.fatal(message, error, this.mergeContext(context), metadata);
  }

  public logPerformance(
    message: string,
    duration: number,
    context?: LogContext,
    metadata?: any
  ): void {
    this.logger.logPerformance(
      message,
      duration,
      this.mergeContext(context),
      metadata
    );
  }
}

// Singleton instance
export const logger = new Logger();

export default logger;
