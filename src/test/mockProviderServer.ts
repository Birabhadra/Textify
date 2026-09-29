// Local stand-in for provider APIs, used by tests and scripts/benchmark-latency.js.
// Speaks OpenAI-compatible SSE on POST */chat/completions and Anthropic SSE on POST */v1/messages.
import * as http from 'http';
import { AddressInfo } from 'net';

export interface RecordedRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: any;
}

export interface MockServerOptions {
    /** Delay before the first token is written (simulates model queue + prefill). */
    firstTokenDelayMs?: number;
    /** Delay between streamed chunks. */
    interChunkDelayMs?: number;
    /** Text streamed back, split into chunks of ~4 chars. */
    responseText?: string;
    /** Final Anthropic stop_reason. */
    stopReason?: string;
    /** Respond with this HTTP status + body instead of a stream. */
    failWith?: { status: number; body: string };
    /** Reject `stream_options` with a 400 like a strict self-hosted server. */
    rejectStreamOptions?: boolean;
    /** Models listed on GET /v1/models (OpenAI style) and/or GET /api/tags (Ollama style). */
    openAIModels?: string[];
    ollamaModels?: string[];
}

/** Token usage the mock reports (OpenAI: prompt includes the cached part). */
export const MOCK_USAGE = { input: 120, cached: 20, cacheWrite: 10, output: 9 };

export interface MockProviderServer {
    baseUrl: string;
    requests: RecordedRequest[];
    /** Number of TCP connections accepted so far (connection reuse check). */
    connections(): number;
    options: MockServerOptions;
    close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunk(text: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += 4) {
        out.push(text.slice(i, i + 4));
    }
    return out;
}

export async function startMockProviderServer(options: MockServerOptions = {}): Promise<MockProviderServer> {
    const requests: RecordedRequest[] = [];
    let connectionCount = 0;
    const state: MockServerOptions = { firstTokenDelayMs: 0, interChunkDelayMs: 0, responseText: 'return value;', ...options };

    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const part of req) {
            raw += part;
        }
        let body: any = undefined;
        try {
            body = raw ? JSON.parse(raw) : undefined;
        } catch {
            body = raw;
        }
        requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });

        if (req.method === 'HEAD') {
            res.writeHead(204).end();
            return;
        }
        if (state.failWith) {
            res.writeHead(state.failWith.status, { 'content-type': 'application/json' }).end(state.failWith.body);
            return;
        }

        const pieces = chunk(state.responseText ?? '');
        const pathname = new URL(req.url ?? '/', 'http://mock').pathname;
        if (req.method === 'GET' && pathname.endsWith('/models') && state.openAIModels) {
            res.writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ object: 'list', data: state.openAIModels.map((id) => ({ id, object: 'model' })) }));
            return;
        }
        if (req.method === 'GET' && pathname === '/api/tags' && state.ollamaModels) {
            res.writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ models: state.ollamaModels.map((name) => ({ name, model: name })) }));
            return;
        }
        if (pathname.endsWith('/chat/completions')) {
            if (state.rejectStreamOptions && body?.stream_options) {
                res.writeHead(400, { 'content-type': 'application/json' })
                    .end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            await sleep(state.firstTokenDelayMs ?? 0);
            for (const piece of pieces) {
                res.write(`data: ${JSON.stringify({ model: body?.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
                await sleep(state.interChunkDelayMs ?? 0);
            }
            if (body?.stream_options?.include_usage) {
                res.write(`data: ${JSON.stringify({ choices: [], usage: {
                    prompt_tokens: MOCK_USAGE.input + MOCK_USAGE.cached,
                    completion_tokens: MOCK_USAGE.output,
                    prompt_tokens_details: { cached_tokens: MOCK_USAGE.cached }
                } })}\n\n`);
            }
            res.end('data: [DONE]\n\n');
            return;
        }

        if (pathname.endsWith('/v1/messages')) {
            const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_mock' });
            await sleep(state.firstTokenDelayMs ?? 0);
            send('message_start', {
                type: 'message_start',
                message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body?.model, content: [], stop_reason: null, stop_sequence: null, usage: {
                    input_tokens: MOCK_USAGE.input, output_tokens: 1,
                    cache_read_input_tokens: MOCK_USAGE.cached, cache_creation_input_tokens: MOCK_USAGE.cacheWrite
                } }
            });
            send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            for (const piece of pieces) {
                send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
                await sleep(state.interChunkDelayMs ?? 0);
            }
            send('content_block_stop', { type: 'content_block_stop', index: 0 });
            send('message_delta', { type: 'message_delta', delta: { stop_reason: state.stopReason ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: MOCK_USAGE.output } });
            send('message_stop', { type: 'message_stop' });
            res.end();
            return;
        }

        res.writeHead(404).end('not found');
    });
    server.on('connection', () => connectionCount++);
    server.keepAliveTimeout = 60_000;

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        connections: () => connectionCount,
        options: state,
        close: () => new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        })
    };
}
