import { handleWebOptIn } from '../../lib/sms-consent.mjs';

export async function onRequestPost({ request, env }) {
  return handleWebOptIn(request, env);
}
