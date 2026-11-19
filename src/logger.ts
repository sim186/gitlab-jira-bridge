import { pino, type Logger } from 'pino';

export default function buildLogger(level: string): Logger {
  return pino({ level, base: undefined });
}
