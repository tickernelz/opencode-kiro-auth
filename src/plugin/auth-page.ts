function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function getIDCAuthHtml(
  verificationUrl: string,
  userCode: string,
  statusUrl: string
): string {
  const escapedUrl = escapeHtml(verificationUrl)
  const escapedCode = escapeHtml(userCode)
  const escapedStatusUrl = escapeHtml(statusUrl)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AWS Builder ID Authentication</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 48px 40px;
      text-align: center;
      animation: slideIn 0.4s ease-out;
    }
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    h1 {
      color: #1a202c;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .subtitle {
      color: #718096;
      font-size: 16px;
      margin-bottom: 32px;
      line-height: 1.5;
    }
    .code-container {
      background: #f7fafc;
      border: 2px solid #e2e8f0;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      position: relative;
    }
    .code-label {
      color: #4a5568;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .code {
      font-family: 'Courier New', monospace;
      font-size: 32px;
      font-weight: 700;
      color: #2d3748;
      letter-spacing: 4px;
      user-select: all;
      cursor: pointer;
      padding: 8px;
      border-radius: 6px;
      transition: background 0.2s;
    }
    .code:hover {
      background: #edf2f7;
    }
    .copy-hint {
      color: #a0aec0;
      font-size: 12px;
      margin-top: 8px;
    }
    .url-container {
      margin-bottom: 32px;
    }
    .url-label {
      color: #4a5568;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .url-link {
      display: inline-block;
      color: #4299e1;
      text-decoration: none;
      font-size: 16px;
      padding: 12px 24px;
      border: 2px solid #4299e1;
      border-radius: 8px;
      transition: all 0.2s;
      font-weight: 600;
    }
    .url-link:hover {
      background: #4299e1;
      color: white;
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(66, 153, 225, 0.4);
    }
    .status {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: #718096;
      font-size: 14px;
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #e2e8f0;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 3px solid #e2e8f0;
      border-top-color: #4299e1;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .instructions {
      background: #edf2f7;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
      text-align: left;
    }
    .instructions ol {
      margin-left: 20px;
      color: #4a5568;
      font-size: 14px;
      line-height: 1.8;
    }
    .instructions li {
      margin-bottom: 8px;
    }
    @media (max-width: 600px) {
      .container {
        padding: 32px 24px;
      }
      h1 {
        font-size: 24px;
      }
      .code {
        font-size: 24px;
        letter-spacing: 2px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>AWS Builder ID Authentication</h1>
    <p class="subtitle">Complete the authentication in your browser</p>
    
    <div class="instructions">
      <ol>
        <li>A browser window will open automatically</li>
        <li>Enter the code shown below</li>
        <li>Complete the authentication process</li>
      </ol>
    </div>

    <div class="code-container">
      <div class="code-label">Your Code</div>
      <div class="code" onclick="copyCode()">${escapedCode}</div>
      <div class="copy-hint">Click to copy</div>
    </div>

    <div class="url-container">
      <div class="url-label">Verification URL</div>
      <a href="${escapedUrl}" target="_blank" class="url-link">Open Browser</a>
    </div>

    <div class="status">
      <div class="spinner"></div>
      <span>Waiting for authentication...</span>
    </div>
  </div>

  <script>
    const statusUrl = '${escapedStatusUrl}';
    const verificationUrl = '${escapedUrl}';
    
    function copyCode() {
      const code = '${escapedCode}';
      navigator.clipboard.writeText(code).then(() => {
        const codeEl = document.querySelector('.code');
        const originalBg = codeEl.style.background;
        codeEl.style.background = '#48bb78';
        codeEl.style.color = 'white';
        setTimeout(() => {
          codeEl.style.background = originalBg;
          codeEl.style.color = '#2d3748';
        }, 300);
      }).catch(() => {});
    }

    async function checkStatus() {
      try {
        const response = await fetch(statusUrl);
        const data = await response.json();
        
        if (data.status === 'success') {
          window.location.href = '/success';
        } else if (data.status === 'failed' || data.status === 'timeout') {
          window.location.href =
            '/error?message=' +
            encodeURIComponent(data.error || data.message || 'Authentication failed');
        }
      } catch (error) {
        console.error('Status check failed:', error);
      }
    }

    setInterval(checkStatus, 2000);
    checkStatus();
  </script>
</body>
</html>`
}

export function getIDCCombinedHtml(
  defaultStartUrl: string,
  defaultRegion: string,
  beginUrl: string,
  statusUrl: string
): string {
  const escapedStartUrl = escapeHtml(defaultStartUrl)
  const escapedRegion = escapeHtml(defaultRegion)
  const escapedBeginUrl = escapeHtml(beginUrl)
  const escapedStatusUrl = escapeHtml(statusUrl)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AWS Builder ID Authentication</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 640px;
      width: 100%;
      padding: 48px 40px;
      animation: slideIn 0.4s ease-out;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    h1 {
      color: #1a202c;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 10px;
      text-align: center;
    }
    .subtitle {
      color: #718096;
      font-size: 16px;
      margin-bottom: 22px;
      line-height: 1.5;
      text-align: center;
    }
    .field { margin-top: 14px; }
    label {
      display: block;
      color: #4a5568;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 10px;
    }
    input {
      width: 100%;
      border: 2px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px 14px;
      font-size: 14px;
      outline: none;
    }
    input:focus {
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.15);
    }
    .hint {
      color: #a0aec0;
      font-size: 12px;
      margin-top: 8px;
      line-height: 1.4;
    }
    .actions {
      margin-top: 18px;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    button {
      border: none;
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 700;
      color: white;
      background: #667eea;
      cursor: pointer;
    }
    button:hover { background: #5a67d8; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .divider {
      height: 1px;
      background: #e2e8f0;
      margin: 22px 0;
    }
    .error {
      display: none;
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 12px;
      background: #fff5f5;
      border: 1px solid #fed7d7;
      color: #c53030;
      font-size: 14px;
      line-height: 1.4;
    }
    .auth {
      display: none;
      margin-top: 18px;
    }
    .code-container {
      background: #f7fafc;
      border: 2px solid #e2e8f0;
      border-radius: 12px;
      padding: 22px;
      margin-top: 14px;
      text-align: center;
    }
    .code-label {
      color: #4a5568;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }
    .code {
      font-family: 'Courier New', monospace;
      font-size: 32px;
      font-weight: 700;
      color: #2d3748;
      letter-spacing: 4px;
      user-select: all;
      cursor: pointer;
      padding: 8px;
      border-radius: 6px;
      transition: background 0.2s;
    }
    .code:hover { background: #edf2f7; }
    .copy-hint {
      color: #a0aec0;
      font-size: 12px;
      margin-top: 8px;
    }
    .url-container { margin-top: 14px; }
    .url-label {
      color: #4a5568;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 10px;
      text-align: center;
    }
    .url-link {
      display: inline-block;
      color: #4299e1;
      text-decoration: none;
      font-size: 14px;
      padding: 12px 16px;
      border: 2px solid #4299e1;
      border-radius: 12px;
      transition: all 0.2s;
      font-weight: 600;
    }
    .url-link:hover {
      background: #4299e1;
      color: white;
      transform: translateY(-1px);
      box-shadow: 0 8px 20px rgba(66, 153, 225, 0.35);
    }
    .status {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 18px;
      color: #718096;
      font-size: 14px;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid #e2e8f0;
      border-top: 2px solid #667eea;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 600px) {
      .container { padding: 32px 24px; }
      h1 { font-size: 24px; }
      .code { font-size: 28px; letter-spacing: 3px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>AWS Builder ID Authentication</h1>
    <p class="subtitle">Using the defaults below. If needed, edit them and click Begin. The AWS verification page opens only when you click "Open Browser".</p>

    <form id="beginForm">
      <div class="field">
        <label for="startUrl">Start URL</label>
        <input id="startUrl" name="startUrl" type="url" required value="${escapedStartUrl}" />
        <div class="hint">We normalize to <code>https://&lt;host&gt;/start</code> and may follow redirects to the canonical AWS access portal.</div>
      </div>
      <div class="field">
        <label for="region">Region</label>
        <input id="region" name="region" type="text" required value="${escapedRegion}" />
        <div class="hint">Region for your IAM Identity Center instance (e.g. <code>eu-west-1</code>).</div>
      </div>
      <div class="actions">
        <button id="beginBtn" type="submit">Begin</button>
      </div>
      <div id="error" class="error"></div>
    </form>

    <div class="divider"></div>

    <div id="auth" class="auth">
      <div class="code-container">
        <div class="code-label">User Code</div>
        <div id="code" class="code" onclick="copyCode()"></div>
        <div class="copy-hint">Click to copy</div>
      </div>

      <div class="url-container" style="text-align:center;">
        <div class="url-label">Verification URL</div>
        <a id="openLink" href="#" target="_blank" class="url-link" rel="noreferrer">Open Browser</a>
      </div>

      <div class="status">
        <div class="spinner"></div>
        <span id="statusText">Preparing authorization...</span>
      </div>
    </div>
  </div>

  <script>
    const beginUrl = '${escapedBeginUrl}';
    const statusUrl = '${escapedStatusUrl}';

    const form = document.getElementById('beginForm');
    const beginBtn = document.getElementById('beginBtn');
    const errorEl = document.getElementById('error');
    const authEl = document.getElementById('auth');
    const codeEl = document.getElementById('code');
    const openLink = document.getElementById('openLink');
    const statusText = document.getElementById('statusText');

    let currentCode = '';
    let pollTimer = null;

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    }

    function clearError() {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function copyCode() {
      if (!currentCode) return;
      navigator.clipboard.writeText(currentCode).then(() => {
        const originalBg = codeEl.style.background;
        codeEl.style.background = '#48bb78';
        codeEl.style.color = 'white';
        setTimeout(() => {
          codeEl.style.background = originalBg;
          codeEl.style.color = '#2d3748';
        }, 300);
      }).catch(() => {});
    }

    async function checkStatus() {
      try {
        const response = await fetch(statusUrl);
        const data = await response.json();
        if (data.status === 'success') {
          stopPolling();
          window.location.href = '/success';
        } else if (data.status === 'failed' || data.status === 'timeout') {
          stopPolling();
          window.location.href = '/error?message=' + encodeURIComponent(data.error || data.message || 'Authentication failed');
        }
      } catch (e) {
        // Keep polling; transient fetch errors can happen.
      }
    }

    async function beginAuth() {
      clearError();
      stopPolling();

      const startUrl = document.getElementById('startUrl').value;
      const region = document.getElementById('region').value;

      beginBtn.disabled = true;
      statusText.textContent = 'Starting authorization...';
      try {
        const u = beginUrl + '?startUrl=' + encodeURIComponent(startUrl) + '&region=' + encodeURIComponent(region);
        const res = await fetch(u);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.message || 'Failed to begin authentication');
        }

        currentCode = data.userCode || '';
        codeEl.textContent = currentCode;

        const vurl = data.verificationUriComplete || data.verificationUrl;
        if (!vurl) {
          throw new Error('Missing verification URL in response');
        }
        openLink.href = vurl;

        authEl.style.display = 'block';
        statusText.textContent = 'Waiting for authentication...';
        pollTimer = setInterval(checkStatus, 2000);
        checkStatus();
      } catch (err) {
        showError(err && err.message ? err.message : String(err));
      } finally {
        beginBtn.disabled = false;
      }
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await beginAuth();
    });

    // Auto-begin once using the defaults so the page immediately shows
    // the user code + "Open Browser" button.
    window.addEventListener('load', () => {
      beginAuth().catch(() => {});
    });
  </script>
</body>
</html>`
}

export function getIDCStartHtml(
  defaultStartUrl: string,
  defaultRegion: string,
  beginUrl: string
): string {
  const escapedStartUrl = escapeHtml(defaultStartUrl)
  const escapedRegion = escapeHtml(defaultRegion)
  const escapedBeginUrl = escapeHtml(beginUrl)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AWS Builder ID Authentication</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 560px;
      width: 100%;
      padding: 48px 40px;
      animation: slideIn 0.4s ease-out;
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(-20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    h1 {
      color: #1a202c;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 12px;
      text-align: center;
    }
    .subtitle {
      color: #718096;
      font-size: 16px;
      margin-bottom: 24px;
      line-height: 1.5;
      text-align: center;
    }
    .field {
      margin-top: 18px;
    }
    label {
      display: block;
      color: #4a5568;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 10px;
    }
    input {
      width: 100%;
      border: 2px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px 14px;
      font-size: 14px;
      outline: none;
    }
    input:focus {
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.15);
    }
    .hint {
      color: #a0aec0;
      font-size: 12px;
      margin-top: 8px;
      line-height: 1.4;
    }
    .actions {
      margin-top: 22px;
      display: flex;
      justify-content: flex-end;
    }
    button {
      border: none;
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 14px;
      font-weight: 700;
      color: white;
      background: #667eea;
      cursor: pointer;
    }
    button:hover { background: #5a67d8; }
    @media (max-width: 600px) {
      .container { padding: 32px 24px; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>AWS Builder ID Authentication</h1>
    <p class="subtitle">Choose the AWS start URL and begin the device authorization flow.</p>
    <form method="GET" action="${escapedBeginUrl}">
      <div class="field">
        <label for="startUrl">Start URL</label>
        <input id="startUrl" name="startUrl" type="url" required value="${escapedStartUrl}" />
        <div class="hint">Paste your org portal URL. We'll normalize it and may follow redirects to the underlying AWS access portal hostname.</div>
      </div>
      <div class="field">
        <label for="region">Region</label>
        <input id="region" name="region" type="text" required value="${escapedRegion}" />
        <div class="hint">Region for your IAM Identity Center instance (e.g. us-east-1, eu-west-1).</div>
      </div>
      <div class="actions">
        <button type="submit">Begin</button>
      </div>
    </form>
  </div>
</body>
</html>`
}

export function getSuccessHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Successful</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #48bb78 0%, #38a169 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 450px;
      width: 100%;
      padding: 48px 40px;
      text-align: center;
      animation: slideIn 0.4s ease-out;
    }
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: scale(0.9);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    .checkmark {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      position: relative;
    }
    .checkmarkcle {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: #48bb78;
      animation: scaleIn 0.5s ease-out;
    }
    @keyframes scaleIn {
      from {
        transform: scale(0);
      }
      to {
        transform: scale(1);
      }
    }
    .checkmark-check {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 30px;
      height: 50px;
      border: solid white;
      border-width: 0 6px 6px 0;
      transform: translate(-50%, -60%) rotate(45deg);
      animation: checkmark 0.5s 0.3s ease-out forwards;
      opacity: 0;
    }
    @keyframes checkmark {
      to {
        opacity: 1;
        transform: translate(-50%, -60%) rotate(45deg) scale(1);
      }
    }
    h1 {
      color: #1a202c;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .message {
      color: #718096;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .auto-close {
      color: #a0aec0;
      font-size: 14px;
      padding-top: 24px;
      border-top: 1px solid #e2e8f0;
    }
    @media (max-width: 600px) {
      .container {
        padding: 32px 24px;
      }
      h1 {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">
      <div class="checkmark-circle"></div>
      <div class="checkmark-check"></div>
    </div>
    <h1>Authentication Successful!</h1>
    <p class="message">You have been successfully authenticated with AWS Builder ID. You can now close this window and return to your terminal.</p>
    <div class="auto-close">This window will close automatically in <span id="countdown">3</span> seconds</div>
  </div>

  <script>
    let seconds = 3;
    const countdownEl = document.getElementById('countdown');
    
    const interval = setInterval(() => {
      seconds--;
      if (countdownEl) {
        countdownEl.textContent = seconds.toString();
      }
      
      if (seconds <= 0) {
        clearInterval(interval);
        try {
          window.close();
        } catch (e) {
          console.log('Couluto-close window');
        }
      }
    }, 1000);
  </script>
</body>
</html>`
}

export function getErrorHtml(message: string): string {
  const escapedMessage = escapeHtml(message)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Failed</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: linear-gradient(135deg, #fc8181 0%, #f56565 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 450px;
      width: 100%;
      padding: 48px 40px;
      text-align: center;
      animation: slideIn 0.4s ease-out;
    }
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: scale(0.9);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    .error-icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      position: relative;
    }
    .error-circle {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: #fc8181;
      animation: scaleIn 0.5s ease-out;
    }
    @keyframes scaleIn {
      from {
        transform: scale(0);
      }
      to {
        transform: scale(1);
      }
    }
    .error-x {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 40px;
      height: 40px;
    }
    .error-x::before,
    .error-x::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 40px;
      height: 6px;
      background: white;
      border-radius: 3px;
      animation: xmark 0.5s 0.3s ease-out forwards;
      opacity: 0;
    }
    .error-x::before {
      transform: translate(-50%, -50%) rotate(45deg);
    }
    .error-x::after {
      transform: translate(-50%, -50%) rotate(-45deg);
    }
    @keyframes xmark {
      to {
        opacity: 1;
      }
    }
    h1 {
      color: #1a202c;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 12px;
    }
    .message {
      color: #718096;
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 16px;
    }
    .error-details {
      background: #fff5f5;
      border: 1px solid #feb2b2;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
      color: #c53030;
      font-size: 14px;
      word-break: break-word;
    }
    .instruction {
      color: #4a5568;
      font-size: 15px;
      margin-bottom: 24px;
    }
    .auto-close {
      color: #a0aec0;
      font-size: 14px;
      padding-top: 24px;
      border-top: 1px solid #e2e8f0;
    }
    @media (max-width: 600px) {
      .container {
        padding: 32px 24px;
      }
      h1 {
        font-size: 24px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">
      <div class="error-circle"></div>
      <div class="error-x"></div>
    </div>
    <h1>Authentication Failed</h1>
    <p class="message">We were unable to complete the authentication process.</p>
    <div class="error-details">${escapedMessage}</div>
    <p class="instruction">You can close this window and try again from your terminal.</p>
    <div class="auto-close">This window will close automatically in <span id="countdown">5</span> seconds</div>
  </div>

  <script>
    let seconds = 5;
    const countdownEl = document.getElementById('countdown');
    
    const interval = setInterval(() => {
      seconds--;
      if (countdownEl) {
        countdownEl.textContent = seconds.toString();
      }
      
      if (seconds <= 0) {
        clearInterval(interval);
        try {
          window.close();
        } catch (e) {
          console.log('Could not auto-close window');
        }
      }
    }, 1000);
  </script>
</body>
</html>`
}
