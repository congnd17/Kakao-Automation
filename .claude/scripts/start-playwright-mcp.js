// Khởi động Playwright MCP sau khi xoá log/snapshot của phiên trước trong .playwright-mcp/.
// Chỉ phiên đang chạy giữ log (để debug); phiên mới luôn bắt đầu với thư mục sạch.
// Snapshot chụp hệ thống thật — có thể chứa dữ liệu khách hàng, không nên tích luỹ.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

fs.rmSync(path.resolve(process.cwd(), '.playwright-mcp'), { recursive: true, force: true });

// Chuỗi lệnh + shell (không truyền mảng args kèm shell — Node cảnh báo DEP0190); npx trên Windows là .cmd nên cần shell.
const child = spawn(['npx -y @playwright/mcp@latest', ...process.argv.slice(2)].join(' '), { stdio: 'inherit', shell: true });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
