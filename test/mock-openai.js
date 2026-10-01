const http = require('http');

http
  .createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const input = body ? JSON.parse(body) : {};
      const messages = Array.isArray(input.messages) ? input.messages : [];
      const last = messages.at(-1)?.content || '';
      const system = messages.find((message) => message.role === 'system')?.content || '';
      const marker = '\n\nТекущий контекст Grafana:\n';
      const documentMessage = messages.find((message) => typeof message.content === 'string' && message.content.startsWith('Файл: grafana-context.json'));
      const documentMatch = documentMessage && /```json\n([\s\S]*?)\n```/.exec(documentMessage.content);
      const rawContext = documentMatch ? documentMatch[1] : (system.includes(marker) ? system.slice(system.indexOf(marker) + marker.length) : '{}');
      let context;
      try {
        context = JSON.parse(rawContext);
      } catch {
        context = { parseError: true, raw: rawContext };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: `mock: ${last}\n\nСпособ контекста: ${documentMatch ? 'grafana-context.json' : 'system prompt'}\nПолученный контекст Grafana:\n${JSON.stringify(context, null, 2)}`,
            },
          }],
        })
      );
    });
  })
  .listen(8080, '0.0.0.0');
