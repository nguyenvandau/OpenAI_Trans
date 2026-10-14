import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const problems = [];
if (Number(process.versions.node.split('.')[0]) < 20) problems.push('Cần Node.js 20 trở lên trên server.');
const configured = name => {
  const key = (process.env[name] || '').trim();
  return Boolean(key) && !/^(sk-\.\.\.|AIza\.\.\.|API_KEY_CUA_BAN|your[_ -]?api[_ -]?key.*)$/i.test(key);
};
if (!configured('OPENAI_API_KEY') && !configured('GEMINI_API_KEY')) {
  problems.push('Chép file .env đã có API key vào thư mục AI-Cabin, hoặc điền OPENAI_API_KEY (GPT) và/hoặc GEMINI_API_KEY (Gemini) trong file .env rồi chạy lại.');
}
const provider = (process.env.TRANSLATION_PROVIDER || '').trim().toLowerCase();
if (provider && !['openai', 'gemini'].includes(provider)) problems.push('TRANSLATION_PROVIDER trong .env phải là openai hoặc gemini.');
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT trong .env phải là số từ 1 đến 65535.');
if (process.env.PUBLIC_BASE_URL) {
  try {
    const url = new URL(process.env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
  } catch {
    problems.push('PUBLIC_BASE_URL phải là địa chỉ http:// hoặc https:// của server.');
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
