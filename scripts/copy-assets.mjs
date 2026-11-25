/* The SQL migrations and the e-mail logo are read at run time: copied beside the compiled code. */
import { cpSync } from 'node:fs';

cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
cpSync('src/assets', 'dist/assets', { recursive: true });
console.log('assets copied');
