// 站点配置：线上版（GitHub Pages）的默认中转服务。换中转（比如绑了自己的域名）只改这里。
// 这是一个公开的服务地址，不是密钥；玩家的 key 由页面随请求带给它，它只转发、不保存。
// 代码见 relay/cloudflare-worker.js。
export const DEFAULT_RELAY_URL = 'https://tankrelay.wubuguiqazwsxmail.workers.dev';
