import express, { Router } from 'express';
import { createRateLimiter } from '../middleware/rate-limit.middleware';
import {
  showDeletionConfirmPage,
  showDeletionRequestPage,
  submitDeletionConfirm,
  submitDeletionRequest,
} from '../controllers/account-deletion-page.controller';

/**
 * Public account pages served as plain HTML outside /v1. Mounted before the
 * API's CORS, CSRF, and encryption middleware: these same-origin forms carry
 * no ambient credentials, and the one-time e-mailed token is the only
 * authenticator (same model as password reset).
 */
const router = Router();
const isProduction = process.env.NODE_ENV === 'production';

const requestLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: isProduction ? 5 : 100,
  message: 'Too many requests, please try again later',
});
const confirmLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: isProduction ? 20 : 200,
  message: 'Too many requests, please try again later',
});

router.use(express.urlencoded({ extended: false, limit: '4kb' }));

router.get('/delete', showDeletionRequestPage);
router.post('/delete', requestLimiter, submitDeletionRequest);
router.get('/delete/confirm', confirmLimiter, showDeletionConfirmPage);
router.post('/delete/confirm', confirmLimiter, submitDeletionConfirm);

export default router;
