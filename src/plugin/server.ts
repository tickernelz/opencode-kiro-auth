import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { parse as parseUrl } from 'node:url';
import * as logger from './logger';

const DEFAULT_PORT = 8080;
const CALLBACK_TIMEOUT = 5 * 60 * 1000;

interface CallbackResult {
  code: string;
  state: string;
}

interface CallbackServerResult {
  url: string;
  waitForCallback: () => Promise<CallbackResult>;
}

function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  
  try {
    const parsed = parseUrl(url, true);
    const query = parsed.query;
    
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string') {
        params[key] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        params[key] = value[0] as string;
      }
    }
  } catch (error) {
    logger.error('Failed to parse query params', error);
  }
  
  return params;
}

function sendHtmlResponse(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function sendErrorResponse(res: ServerResponse, statusCode: number, message: string): void {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Error</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    h1 {
      color: #e74c3c;
      margin: 0 0 1rem 0;
    }
    p {
      color: #666;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Error</h1>
    <p>${message}</p>
  </div>
</body>
</html>
  `.trim();
  
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

function sendSuccessResponse(res: ServerResponse): void {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #f5f5f5;
    }
    .container {
      text-align: center;
      padding: 2rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    h1 {
      color: #27ae60;
      margin: 0 0 1rem 0;
    }
    p {
      color: #666;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
</body>
</html>
  `.trim();
  
  sendHtmlResponse(res, html);
}

export async function startCallbackServer(port: number = DEFAULT_PORT): Promise<CallbackServerResult> {
  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let callbackResolver: ((result: CallbackResult) => void) | null = null;
    let callbackRejector: ((error: Error) => void) | null = null;
    
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      
      if (server) {
        server.close((err) => {
          if (err) {
            logger.error('Error closing callback server', err);
          }
        });
        server = null;
      }
    };
    
    const handleRequest = (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url || '';
      
      if (!url.startsWith('/callback')) {
        sendErrorResponse(res, 404, 'Not Found');
        return;
      }
      
      const params = parseQueryParams(url);
      const code = params.code;
      const state = params.state;
      
      if (!code) {
        sendErrorResponse(res, 400, 'Missing authorization code');
        if (callbackRejector) {
          callbackRejector(new Error('Missing authorization code'));
        }
        cleanup();
        return;
      }
      
      if (!state) {
        sendErrorResponse(res, 400, 'Missing state parameter');
        if (callbackRejector) {
          callbackRejector(new Error('Missing state parameter'));
        }
        cleanup();
        return;
      }
      
      sendSuccessResponse(res);
      
      if (callbackResolver) {
        callbackResolver({ code, state });
      }
      
      cleanup();
    };
    
    server = createServer(handleRequest);
    
    server.on('error', (error) => {
      logger.error('Callback server error', error);
      cleanup();
      reject(error);
    });
    
    server.listen(port, 'localhost', () => {
      const url = `http://localhost:${port}/callback`;
      logger.log('Callback server started', { url });
      
      timeoutId = setTimeout(() => {
        logger.warn('Callback server timeout');
        if (callbackRejector) {
          callbackRejector(new Error('Callback timeout'));
        }
        cleanup();
      }, CALLBACK_TIMEOUT);
      
      const waitForCallback = (): Promise<CallbackResult> => {
        return new Promise((resolveCallback, rejectCallback) => {
          callbackResolver = resolveCallback;
          callbackRejector = rejectCallback;
        });
      };
      
      resolve({
        url,
        waitForCallback,
      });
    });
  });
}
