const ts = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

export const log = {
  info: (msg: string) => console.log(`[${ts()}] INFO  ${msg}`),
  warn: (msg: string) => console.warn(`[${ts()}] WARN  ${msg}`),
  error: (msg: string) => console.error(`[${ts()}] ERROR ${msg}`),
};
