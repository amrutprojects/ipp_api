import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { config } from '../config';

export const hashPassword = (password: string) => bcrypt.hash(password, config.bcryptRounds);

/* An unknown account is compared against this, so the answer takes as long as for a known one. */
const DUMMY = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), config.bcryptRounds);

export const passwordMatches = (password: string, hash: string | null | undefined) => bcrypt.compare(password, hash ?? DUMMY);
