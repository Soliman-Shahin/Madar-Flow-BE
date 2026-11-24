import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import {
  showPrivacyPage,
  showTermsPage,
} from '../controllers/legal-page.controller';

/**
 * Public Privacy Policy / Terms pages (plain HTML, GET only, no credentials). Mounted before the
 * API's CORS, CSRF and encryption middleware, like the public account pages.
 */
const router = Router();

// Express 5 does not forward rejected promises from async handlers on its own in every setup;
// keep the page resilient and let the central error handler answer.
const safe =
  (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

router.get('/privacy', safe(showPrivacyPage));
router.get('/terms', safe(showTermsPage));

export default router;
