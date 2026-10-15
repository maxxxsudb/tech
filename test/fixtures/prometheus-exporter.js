const http = require('node:http');
const os = require('node:os');
http.createServer((req, res) => {
  if (req.url !== '/metrics') { res.writeHead(404); return res.end(); }
  const lines = [
    '# TYPE tech_exporter_memory_bytes gauge',
    `tech_exporter_memory_bytes{kind="free",environment="test"} ${os.freemem()}`,
    `tech_exporter_memory_bytes{kind="total",environment="test"} ${os.totalmem()}`,
    '# TYPE tech_exporter_uptime_seconds gauge',
    `tech_exporter_uptime_seconds{environment="test"} ${os.uptime()}`,
  ];
  for (let i = 0; i < 105; i++) lines.push(`tech_exporter_probe_${i}{environment="test"} ${i}`);
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
  res.end(lines.join('\n') + '\n');
}).listen(19100, '0.0.0.0');
