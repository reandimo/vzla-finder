/**
 * Aviso por email de sugerencias de fuentes nuevas.
 *
 * Sin dependencias: usa el `sendmail` del sistema (presente en cPanel/CloudLinux
 * vía Exim). Es "fire and forget" y a prueba de fallos: si no hay sendmail (p. ej.
 * en local) o algo revienta, NUNCA tira el request — la sugerencia ya quedó
 * guardada en la DB igual.
 *
 * Config por entorno:
 *   SUGGEST_NOTIFY_EMAIL  destinatario (default: reandimo23@gmail.com)
 *   SENDMAIL_PATH         binario sendmail (default: /usr/sbin/sendmail)
 *   SUGGEST_FROM          remitente (default: noreply@vzlafinder.reandimo.dev)
 */
import { spawn } from 'node:child_process';

const TO = process.env.SUGGEST_NOTIFY_EMAIL ?? 'reandimo23@gmail.com';
const SENDMAIL = process.env.SENDMAIL_PATH ?? '/usr/sbin/sendmail';
const FROM = process.env.SUGGEST_FROM ?? 'vzla-finder <noreply@vzlafinder.reandimo.dev>';

export interface SuggestionEmail {
  url: string;
  name: string | null;
  note: string | null;
  createdAt: string;
}

export function notifySuggestion(s: SuggestionEmail): void {
  try {
    const body = [
      `To: ${TO}`,
      `From: ${FROM}`,
      'Subject: Nueva sugerencia de fuente — vzla-finder',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Alguien sugirió una fuente nueva desde el landing:',
      '',
      `  URL:    ${s.url}`,
      `  Nombre: ${s.name ?? '—'}`,
      `  Nota:   ${s.note ?? '—'}`,
      `  Fecha:  ${s.createdAt}`,
      '',
    ].join('\n');

    const child = spawn(SENDMAIL, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => {}); // sin sendmail (local) → no romper nada
    child.stdin.on('error', () => {});
    child.stdin.write(body);
    child.stdin.end();
  } catch {
    /* el email nunca debe tumbar el request */
  }
}
