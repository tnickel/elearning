import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforauthentication123!';
const JWT_ISSUER = process.env.JWT_ISSUER || 'elearning-platform';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'elearning-students';

export interface UserPayload {
  id: string;
  email: string;
  role: 'student' | 'admin' | 'system';
  tenantId: string;
}

// Extend express Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: UserPayload;
    }
  }
}

/**
 * Generates a signed stateless JWT token.
 */
export function generateToken(payload: UserPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: '15m', // Strict 15-minute token lifespan (prevent replay attacks)
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

/**
 * Middleware that authenticates JWT requests.
 * Evaluates expiration, issuer, audience, and type differences.
 */
export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token is required' });
  }

  jwt.verify(token, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  }, (err, decoded) => {
    if (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Access token has expired' });
      }
      return res.status(403).json({ error: 'Invalid token signature or payload validation failed' });
    }

    req.user = decoded as UserPayload;
    next();
  });
}
