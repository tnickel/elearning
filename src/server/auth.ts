import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

dotenv.config();

const DEFAULT_JWT_SECRET = 'supersecretjwtkeyforauthentication123!';

/**
 * Guarantees a secure value for a secret env variable.
 * If the variable is missing or matches a known insecure default, a random
 * value is generated and persisted to .env so tokens/signatures survive
 * restarts. In production the process refuses to start when persistence fails.
 */
export function ensureSecretEnv(name: string, insecureDefaults: string[]): string {
  const current = process.env[name];
  if (current && !insecureDefaults.includes(current)) {
    return current;
  }

  const generated = crypto.randomBytes(48).toString('base64url');
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, 'utf-8');
      const lineRe = new RegExp(`^${name}=.*$`, 'm');
      if (lineRe.test(content)) {
        content = content.replace(lineRe, `${name}=${generated}`);
      } else {
        content += `\n${name}=${generated}\n`;
      }
      fs.writeFileSync(envPath, content, 'utf-8');
      process.env[name] = generated;
      console.warn(`[SECURITY] ${name} fehlte oder entsprach einem bekannten unsicheren Default. Ein zufälliger Wert wurde generiert und in .env gespeichert.`);
      return generated;
    }
  } catch (err: any) {
    console.warn(`[SECURITY] Konnte ${name} nicht in .env persistieren: ${err?.message || err}`);
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(`[SECURITY] ${name} ist fehlend oder unsicher und konnte nicht gesetzt werden. Start im Produktionsmodus verweigert.`);
  }

  console.warn(`[SECURITY] ${name} fehlt/unsicher; verwende temporären Zufallswert (Tokens/Signaturen überleben keinen Neustart).`);
  return generated;
}

const JWT_SECRET = ensureSecretEnv('JWT_SECRET', [DEFAULT_JWT_SECRET]);
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
    // Long enough for multi-lesson AI generation + wizard polling (15 lessons can take >15min)
    expiresIn: '4h',
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
