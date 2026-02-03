import { createServer, type Server, type ServerResponse } from 'node:http'
import { KIRO_CONSTANTS } from '../constants.js'
import { authorizeKiroIDC } from '../kiro/oauth-idc.js'
import { getErrorHtml, getIDCCombinedHtml, getSuccessHtml } from './auth-page.js'
import * as logger from './logger.js'
import type { KiroRegion } from './types.js'

export interface KiroIDCTokenResult {
  email: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId: string
  clientSecret: string
}
export interface IDCAuthData {
  verificationUrl: string
  verificationUriComplete: string
  userCode: string
  deviceCode: string
  clientId: string
  clientSecret: string
  interval: number
  expiresIn: number
  region: KiroRegion
}

interface IDCAuthServerOptions {
  defaultRegion: KiroRegion
  defaultStartUrl: string
}

async function tryPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const testServer = createServer()
    testServer.once('error', () => resolve(false))
    testServer.once('listening', () => {
      testServer.close()
      resolve(true)
    })
    testServer.listen(port, '127.0.0.1')
  })
}

async function findAvailablePort(startPort: number, range: number): Promise<number> {
  for (let i = 0; i < range; i++) {
    const port = startPort + i
    const available = await tryPort(port)
    if (available) return port
  }
  throw new Error(
    `No available ports in range ${startPort}-${startPort + range - 1}. Please close other applications using these ports.`
  )
}

export async function startIDCAuthServer(
  options: IDCAuthServerOptions,
  startPort: number = 19847,
  portRange: number = 10
): Promise<{ url: string; waitForAuth: () => Promise<KiroIDCTokenResult> }> {
  return new Promise(async (resolve, reject) => {
    let port: number
    try {
      port = await findAvailablePort(startPort, portRange)
      logger.log(`Auth server will use port ${port}`)
    } catch (error) {
      logger.error('Failed to find available port', error)
      reject(error)
      return
    }

    let server: Server | null = null
    let timeoutId: any = null
    let resolver: any = null
    let rejector: any = null
    const status: any = { status: 'idle' }

    let authData: IDCAuthData | null = null
    let pollGeneration = 0

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (server) server.close()
    }
    const sendHtml = (res: ServerResponse, html: string) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    }

    const poll = async (generation: number) => {
      try {
        if (!authData) {
          return
        }
        if (generation !== pollGeneration) {
          return
        }
        // AWS SSO OIDC CreateToken expects JSON keys (clientId/clientSecret/deviceCode/grantType)
        // matching the StartDeviceAuthorization flow.
        const body = JSON.stringify({
          clientId: authData.clientId,
          clientSecret: authData.clientSecret,
          deviceCode: authData.deviceCode,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code'
        })

        const res = await fetch(`https://oidc.${authData.region}.amazonaws.com/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': KIRO_CONSTANTS.USER_AGENT,
            Accept: 'application/json'
          },
          body
        })

        const responseText = await res.text()
        let d: any = {}
        if (responseText) {
          try {
            d = JSON.parse(responseText)
          } catch (parseError: any) {
            logger.error(
              `Auth polling error: Failed to parse JSON (status ${res.status})`,
              parseError
            )
            throw parseError
          }
        }
        if (res.ok) {
          const acc = d.access_token || d.accessToken,
            ref = d.refresh_token || d.refreshToken,
            exp = Date.now() + (d.expires_in || d.expiresIn || 0) * 1000
          let email = 'builder-id@aws.amazon.com'
          try {
            const infoRes = await fetch('https://view.awsapps.com/api/user/info', {
              headers: { Authorization: `Bearer ${acc}` }
            })
            if (infoRes.ok) {
              const info = await infoRes.json()
              email = info.email || info.userName || email
            } else {
              logger.warn(
                `User info request failed with status ${infoRes.status}; using fallback email`
              )
            }
          } catch (infoError: any) {
            logger.warn(
              `Failed to fetch user info; using fallback email: ${infoError?.message || infoError}`
            )
          }
          status.status = 'success'
          if (resolver)
            resolver({
              email,
              accessToken: acc,
              refreshToken: ref,
              expiresAt: exp,
              clientId: authData.clientId,
              clientSecret: authData.clientSecret
            })
          setTimeout(cleanup, 2000)
        } else if (d.error === 'authorization_pending') {
          setTimeout(() => poll(generation), authData.interval * 1000)
        } else {
          status.status = 'failed'
          status.error = d.error_description || d.error
          logger.error(`Auth polling failed a: ${status.error}`)
          if (rejector) rejector(new Error(status.error))
          setTimeout(cleanup, 2000)
        }
      } catch (e: any) {
        status.status = 'failed'
        status.error = e.message
        logger.error(`Auth polling error b: ${e.message}`, e)
        if (rejector) rejector(e)
        setTimeout(cleanup, 2000)
      }
    }

    server = createServer((req, res) => {
      const parsed = new URL(req.url || '/', `http://127.0.0.1:${port}`)
      const pathname = parsed.pathname
      if (pathname === '/') {
        sendHtml(
          res,
          getIDCCombinedHtml(
            options.defaultStartUrl,
            options.defaultRegion,
            `http://127.0.0.1:${port}/begin`,
            `http://127.0.0.1:${port}/status`
          )
        )
      } else if (pathname === '/begin') {
        ;(async () => {
          try {
            const startUrl = parsed.searchParams.get('startUrl') || options.defaultStartUrl
            const region = parsed.searchParams.get('region') || options.defaultRegion

            // Validate region format early to avoid confusing OIDC errors.
            if (!/^[a-z]{2}-[a-z-]+-\d+$/.test(region)) {
              throw new Error(`Invalid region: ${region}`)
            }

            status.status = 'pending'
            delete status.error

            pollGeneration++
            const generation = pollGeneration

            if (timeoutId) clearTimeout(timeoutId)
            timeoutId = setTimeout(() => {
              status.status = 'timeout'
              logger.warn('Auth timeout waiting for authorization')
              if (rejector) rejector(new Error('Timeout'))
              cleanup()
            }, 900000)

            const d = await authorizeKiroIDC(region, startUrl)
            authData = d as unknown as IDCAuthData

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                verificationUrl: authData.verificationUrl,
                verificationUriComplete: authData.verificationUriComplete,
                userCode: authData.userCode,
                region: authData.region
              })
            )

            poll(generation)
          } catch (e: any) {
            const msg = e?.message || 'Failed to begin authentication'
            status.status = 'failed'
            status.error = msg
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ message: msg }))
          }
        })().catch(() => {})
      } else if (pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        const payload = {
          ...status,
          message: status.error
        }
        res.end(JSON.stringify(payload))
      } else if (pathname === '/success') sendHtml(res, getSuccessHtml())
      else if (pathname === '/error') {
        const msg = parsed.searchParams.get('message') || status.error || 'Failed'
        sendHtml(res, getErrorHtml(msg))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    server.on('error', (e) => {
      logger.error(`Auth server error on port ${port}`, e)
      cleanup()
      reject(e)
    })
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        waitForAuth: () =>
          new Promise((rv, rj) => {
            resolver = rv
            rejector = rj
          })
      })
    })
  })
}
