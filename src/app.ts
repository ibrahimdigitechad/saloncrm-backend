import 'dotenv/config';
import 'express-async-errors';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { errorHandler } from './lib/errors';
import authRouter     from './routes/auth';
import bookingsRouter from './routes/bookings';
import staffRouter    from './routes/staff';
import customersRouter from './routes/customers';
import servicesRouter from './routes/services';
import settingsRouter from './routes/settings';
import analyticsRouter from './routes/analytics';
import webhookRouter  from './routes/webhook';
import adminRouter    from './routes/admin';
import publicRouter   from './routes/public';
import { startCronJobs } from './services/cron';

const app = express();

// ── Security ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { success: false, error: 'Too many attempts. Please try again in 15 minutes.' } });
app.use('/v1/auth', authLimiter);
app.use(limiter);

// ── Body parsing ─────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// ── Health check ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── API routes ────────────────────────────────────────────
app.use('/v1/auth',       authRouter);
app.use('/v1/bookings',   bookingsRouter);
app.use('/v1/staff',      staffRouter);
app.use('/v1/customers',  customersRouter);
app.use('/v1/services',   servicesRouter);
app.use('/v1/settings',   settingsRouter);
app.use('/v1/analytics',  analyticsRouter);
app.use('/v1/webhook',    webhookRouter);
app.use('/v1/admin',      adminRouter);
app.use('/v1/public',     publicRouter);

// ── Error handler (must be last) ─────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 SalonCRM API running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  startCronJobs();
});

export default app;
