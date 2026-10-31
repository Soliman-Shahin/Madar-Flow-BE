import swaggerJsdoc from 'swagger-jsdoc';
import { BRAND } from './brand.config';

/**
 * Swagger/OpenAPI Configuration
 *
 * Provides interactive API documentation at /api-docs
 */

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: `${BRAND.productName} API`,
    version: '2.0.0',
    description: `Secure backend API for ${BRAND.productName} with advanced encryption and monitoring`,
    contact: {
      name: BRAND.companyName,
      email: 'support@expenses-wallet.com',
    },
    license: {
      name: 'ISC',
    },
  },
  servers: [
    {
      url: 'http://localhost:3000/v1',
      description: 'Development server',
    },
    {
      url: 'https://expenses-wallet.up.railway.app/v1',
      description: 'Production server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter your JWT token',
      },
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'refreshToken',
        description: 'Refresh token stored in HTTP-only cookie',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            example: false,
          },
          error: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                example: 'VALIDATION_ERROR',
              },
              message: {
                type: 'string',
                example: 'Validation failed',
              },
              details: {
                type: 'object',
              },
            },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          _id: {
            type: 'string',
            example: '507f1f77bcf86cd799439011',
          },
          name: {
            type: 'string',
            example: 'John Doe',
          },
          email: {
            type: 'string',
            format: 'email',
            example: 'john@example.com',
          },
          currency: {
            type: 'string',
            example: 'USD',
          },
          language: {
            type: 'string',
            example: 'en',
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
        },
      },
      Expense: {
        type: 'object',
        properties: {
          _id: {
            type: 'string',
            example: '507f1f77bcf86cd799439011',
          },
          title: {
            type: 'string',
            example: 'Grocery Shopping',
          },
          amount: {
            type: 'number',
            example: 150.5,
          },
          category: {
            type: 'string',
            example: '507f1f77bcf86cd799439012',
          },
          date: {
            type: 'string',
            format: 'date-time',
          },
          description: {
            type: 'string',
            example: 'Weekly groceries',
          },
          user: {
            type: 'string',
            example: '507f1f77bcf86cd799439011',
          },
        },
      },
      Category: {
        type: 'object',
        properties: {
          _id: {
            type: 'string',
            example: '507f1f77bcf86cd799439011',
          },
          name: {
            type: 'string',
            example: 'Food & Dining',
          },
          type: {
            type: 'string',
            enum: ['income', 'outcome'],
            example: 'outcome',
          },
          icon: {
            type: 'string',
            example: 'restaurant-outline',
          },
          color: {
            type: 'string',
            example: '#FF6B6B',
          },
          isDefault: {
            type: 'boolean',
            example: false,
          },
          user: {
            type: 'string',
            example: '507f1f77bcf86cd799439011',
          },
        },
      },
    },
  },
  security: [
    {
      bearerAuth: [],
    },
  ],
  tags: [
    {
      name: 'Authentication',
      description: 'User authentication and authorization endpoints',
    },
    {
      name: 'Users',
      description: 'User profile management',
    },
    {
      name: 'Expenses',
      description: 'Expense tracking and management',
    },
    {
      name: 'Categories',
      description: 'Category management for expenses',
    },
    {
      name: 'Sync',
      description: 'Data synchronization endpoints',
    },
  ],
};

const options: swaggerJsdoc.Options = {
  swaggerDefinition,
  // Path to API docs (JSDoc comments in route files)
  apis: ['./src/app/routes/*.ts', './src/app/controllers/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
