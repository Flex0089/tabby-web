import { Buffer } from 'buffer'
import { Subject } from 'rxjs'
import { debounceTime } from 'rxjs/operators'
import { HttpClient } from '@angular/common/http'
import { Injectable } from '@angular/core'
import { LoginService } from '../services/login.service'
import { Config, Gateway, Version } from '../api'

export class SocketProxy {
    connect$ = new Subject<void>()
    data$ = new Subject<Buffer>()
    error$ = new Subject<Buffer>()
    close$ = new Subject<Buffer>()

    url: string
    webSocket: WebSocket
    initialBuffer: Buffer
    options: {
        host: string
        port: number
    }

    constructor (private appConnector: AppConnectorService) {
        this.initialBuffer = Buffer.from('')
    }

    async connect (options) {
        this.options = options
        this.url = this.appConnector.loginService.user.custom_connection_gateway
        if (!this.url) {
            try {
                this.url = (await this.appConnector.chooseConnectionGateway()).url
            } catch (err) {
                this.error$.next(err)
                return
            }
        }
        this.webSocket = new WebSocket(this.url)
        this.webSocket.onmessage = async event => {
            if (typeof(event.data) === 'string') {
                this.handleServiceMessage(JSON.parse(event.data))
            } else {
                this.data$.next(Buffer.from(await event.data.arrayBuffer()))
            }
        }
        this.webSocket.onclose = () => {
            this.close()
        }
    }

    handleServiceMessage (msg) {
        if (msg._ === 'hello') {
            this.sendServiceMessage({
                _: 'hello',
                version: 1,
                auth_token: this.appConnector.loginService.user.custom_connection_gateway_token,
            })
        } else if (msg._ === 'ready') {
            this.sendServiceMessage({
                _: 'connect',
                host: this.options.host,
                port: this.options.port,
            })
        } else if (msg._ === 'connected') {
            this.connect$.next()
            this.connect$.complete()
            this.webSocket.send(this.initialBuffer)
            this.initialBuffer = Buffer.from('')
        } else if (msg._ === 'error') {
            console.error('Connection gateway error', msg)
            this.close(new Error(msg.details))
        } else {
            console.warn('Unknown service message', msg)
        }
    }

    sendServiceMessage (msg) {
        this.webSocket.send(JSON.stringify(msg))
    }

    write (chunk: Buffer): void {
        if (!this.webSocket?.readyState) {
            this.initialBuffer = Buffer.concat([this.initialBuffer, chunk])
        } else {
            this.webSocket.send(chunk)
        }
    }

    close (error?: Error): void {
        this.webSocket.close()
        if (error) {
            this.error$.next(error)
        }
        this.connect$.complete()
        this.data$.complete()
        this.error$.complete()
        this.close$.next()
        this.close$.complete()
    }
}

@Injectable({ providedIn: 'root' })
export class AppConnectorService {
    private configUpdate = new Subject<string>()
    private config: Config
    private version: Version
    sockets: SocketProxy[] = []

    constructor (
        private http: HttpClient,
        public loginService: LoginService,
    ) {
        this.configUpdate.pipe(debounceTime(1000)).subscribe(async content => {
            const result = await this.http.patch(`/api/1/configs/${this.config.id}`, { content }).toPromise()
            Object.assign(this.config, result)
        })
    }

    setState (config: Config, version: Version) {
        this.config = config
        this.version = version
    }

    async loadConfig (): Promise<string> {
        return this.config.content
    }

    async saveConfig (content: string): Promise<void> {
        this.configUpdate.next(content)
        this.config.content = content
    }

    getAppVersion (): string {
        return this.version.version
    }

    getDistURL (): string {
        return '../app-dist'
    }

    getPluginsToLoad (): string[] {
        return [
            'tabby-core',
            'tabby-settings',
            'tabby-terminal',
            'tabby-ssh',
            'tabby-community-color-schemes',
            'tabby-web',
        ]
    }

    createSocket () {
        const socket = new SocketProxy(this)
        this.sockets.push(socket)
        socket.close$.subscribe(() => {
            this.sockets = this.sockets.filter(x => x !== socket)
        })
        return socket
    }

    async chooseConnectionGateway (): Promise<Gateway> {
        return await this.http.post('/api/1/gateways/choose', {}).toPromise()
    }
}
