// Vercel serverless function: report whether a Microsoft Store listing is
// actually published. The browser cannot check apps.microsoft.com directly
// because of CORS, so this same-origin endpoint queries the public Store
// catalog server-side and fails closed.
const PRODUCT_ID_PATTERN = /^[0-9A-Z]{12,14}$/i;
const CATALOG_ORIGIN = 'https://displaycatalog.mp.microsoft.com';

function send(response, status, cacheControl, body) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function unpublished(reason) {
  return { available: false, reason };
}

export default async function handler(request, response) {
  const requestUrl = new URL(request.url ?? '/', 'https://ensync.vercel.app');
  const productId = (requestUrl.searchParams.get('productId') ?? '').trim().toUpperCase();

  if (!PRODUCT_ID_PATTERN.test(productId)) {
    return send(response, 400, 'no-store', unpublished('Invalid Microsoft Store product identifier.'));
  }

  const catalogUrl = `${CATALOG_ORIGIN}/v7.0/products/${productId}?market=US&languages=en-us`;

  try {
    const upstream = await fetch(catalogUrl, {
      headers: {
        Accept: 'application/json',
        'MS-CV': 'ensync-site',
      },
    });

    // The catalog answers 404 with a NotFound body while a listing is still
    // unpublished or private. That is a definitive "not live" result, not an
    // upstream outage.
    if (upstream.status === 404) {
      return send(
        response,
        200,
        'public, max-age=0, s-maxage=120, stale-while-revalidate=300',
        unpublished('The Microsoft Store listing is not published yet.'),
      );
    }

    if (!upstream.ok) {
      return send(
        response,
        502,
        'no-store',
        unpublished('The Microsoft Store could not be verified right now.'),
      );
    }

    const body = await upstream.json().catch(() => null);
    // A published listing exposes a Product object with at least one localized
    // title. An unpublished or private listing returns `{ "code": "NotFound" }`.
    const published = Boolean(
      body?.Product?.ProductId &&
      Array.isArray(body?.Product?.LocalizedProperties) &&
      body.Product.LocalizedProperties.length > 0,
    );

    return send(
      response,
      200,
      'public, max-age=0, s-maxage=120, stale-while-revalidate=300',
      published
        ? { available: true, productId, reason: null }
        : unpublished('The Microsoft Store listing is not published yet.'),
    );
  } catch {
    return send(
      response,
      502,
      'no-store',
      unpublished('The Microsoft Store could not be verified right now.'),
    );
  }
}
