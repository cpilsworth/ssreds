import { describe, expect, it } from 'vitest';
import { buildUpstreamRequest, formatServerTiming, isHtmlResponse } from '../src/proxy';

const ORIGIN = 'https://main--repo--owner.aem.live';

describe('buildUpstreamRequest', () => {
  it('rebuilds the URL against the origin, preserving path and query', () => {
    const req = new Request('https://edge.example.com/path?q=1');
    const upstream = buildUpstreamRequest(req, ORIGIN);
    expect(upstream.url).toBe('https://main--repo--owner.aem.live/path?q=1');
  });

  it('sets the host header to the upstream host', () => {
    const req = new Request('https://edge.example.com/');
    const upstream = buildUpstreamRequest(req, ORIGIN);
    expect(upstream.headers.get('host')).toBe('main--repo--owner.aem.live');
  });

  it('strips hop-by-hop and x-forwarded-* request headers', () => {
    const req = new Request('https://edge.example.com/', {
      headers: {
        accept: 'text/html',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-host': 'edge.example.com',
        connection: 'keep-alive',
      },
    });
    const upstream = buildUpstreamRequest(req, ORIGIN);
    expect(upstream.headers.get('accept')).toBe('text/html');
    expect(upstream.headers.get('x-forwarded-for')).toBeNull();
    expect(upstream.headers.get('x-forwarded-host')).toBeNull();
    expect(upstream.headers.get('connection')).toBeNull();
  });

  it('strips accept-encoding so the origin returns an uncompressed body', () => {
    // Fastly fetch() does not auto-decompress; a gzip/br body would make
    // response.text() throw. The origin must respond with identity encoding.
    const req = new Request('https://edge.example.com/', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    const upstream = buildUpstreamRequest(req, ORIGIN);
    expect(upstream.headers.get('accept-encoding')).toBeNull();
  });

  it('preserves the method and forwards a body on non-GET/HEAD requests', async () => {
    const req = new Request('https://edge.example.com/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    const upstream = buildUpstreamRequest(req, ORIGIN);
    expect(upstream.method).toBe('POST');
    expect(await upstream.text()).toBe('{"hello":"world"}');
  });

  it('does not attach a body for GET requests', () => {
    const req = new Request('https://edge.example.com/');
    const upstream = buildUpstreamRequest(req, ORIGIN);
    expect(upstream.body).toBeNull();
  });
});

describe('isHtmlResponse', () => {
  it('is true for text/html with a charset', () => {
    const res = new Response('', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    expect(isHtmlResponse(res)).toBe(true);
  });

  it('is false for non-HTML content types', () => {
    const res = new Response('', { headers: { 'content-type': 'text/css' } });
    expect(isHtmlResponse(res)).toBe(false);
  });

  it('is false when no content-type is present', () => {
    const res = new Response('');
    expect(isHtmlResponse(res)).toBe(false);
  });
});

describe('formatServerTiming', () => {
  it('formats metrics with fixed-precision durations', () => {
    const out = formatServerTiming({
      total: { dur: 12.3456 },
      upstream: { dur: 8 },
    });
    expect(out).toBe('total;dur=12.346, upstream;dur=8.000');
  });

  it('includes a quoted desc when provided', () => {
    const out = formatServerTiming({ fragments: { dur: 3, desc: '4 fetches' } });
    expect(out).toBe('fragments;dur=3.000;desc="4 fetches"');
  });

  it('returns an empty string for no metrics', () => {
    expect(formatServerTiming({})).toBe('');
  });
});
