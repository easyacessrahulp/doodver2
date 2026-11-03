// The plain (no-AI) email template: used when AI is not set up, or when "plain template" is chosen. Contains no invented facts —
// every missing detail is a visible [confirm: …] placeholder.
export interface TemplateInput { matter: string; recipient?: string | null; company?: string | null; tone: 'formal' | 'polite' | 'friendly' | 'firm'; length: 'short' | 'medium' | 'long'; senderName: string; keyPoints?: string[]; linkedTitle?: string | null }
export const PLACEHOLDER_RE = /\[confirm:[^\]]*\]/gi;
export const placeholdersIn = (...texts: string[]) => [...new Set(texts.join('\n').match(PLACEHOLDER_RE) ?? [])];

export function plainTemplate(i: TemplateInput) {
  const first = i.matter.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const subject = (i.linkedTitle?.trim() || first.slice(0, 90) || '[confirm: subject]');
  const to = i.recipient?.trim() || '[confirm: recipient name]';
  const hello = i.tone === 'friendly' ? `Hi ${to},` : `Dear ${to},`;
  const open = { formal: 'I am writing with reference to the following matter:', polite: 'I hope you are well. I am writing about the following:', friendly: 'Hope you are doing well. Just writing about this:', firm: 'I am writing to address the following matter, which needs your attention:' }[i.tone];
  const ask = i.tone === 'firm' ? 'Kindly confirm [confirm: what you need from the recipient] by [confirm: date]. We would appreciate your prompt response.'
    : 'Could you please [confirm: what you need from the recipient and by when]?';
  const close = { formal: 'Thank you for your time and consideration.', polite: 'Thank you for your help.', friendly: 'Thanks a lot!', firm: 'Thank you for your immediate attention.' }[i.tone];
  const lines = [hello, '', open, '', i.matter.trim()];
  if (i.length !== 'short' && i.keyPoints?.length) lines.push('', 'Background:', ...i.keyPoints.map((k) => `- ${k}`));
  lines.push('', ask);
  if (i.length === 'long') lines.push('', 'Please let me know if any further information or documents are required. [confirm: any documents to attach]');
  lines.push('', close, '', 'Regards,', i.senderName, ...(i.company?.trim() ? [i.company.trim()] : []));
  const body = lines.join('\n');
  return { subject, body, placeholders: placeholdersIn(subject, body) };
}
