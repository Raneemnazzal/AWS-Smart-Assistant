/**
 * Nimbo Pricing Lambda  —  index.mjs
 *
 * What this file does:
 *   1. Receives a request from API Gateway (e.g. GET /pricing?service=ec2)
 *   2. Fetches the current on-demand price from the AWS public Pricing bulk endpoint
 *      (no AWS credentials needed — that URL is publicly accessible)
 *   3. Returns a small JSON object with the monthly cost estimate
 *   4. If the AWS endpoint is unreachable for any reason, returns a hardcoded
 *      fallback value so the frontend never breaks
 *
 * This same file runs locally (via test-local.mjs) AND inside AWS Lambda —
 * no build step, no bundler, no framework.
 */

// ─────────────────────────────────────────────────────────────────────────────
// PRICING ENDPOINT URLS
//
// These are AWS's own public bulk-pricing JSON files.
// You can paste any of these into a browser and see the data yourself.
// No login or API key required.
// ─────────────────────────────────────────────────────────────────────────────
const PRICING_URLS = {
  ec2:      'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json',
  rds:      'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json',
  s3:       'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json',
  lambda:   'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json',
  dynamodb: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/us-east-1/index.json',
  fargate:  'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/us-east-1/index.json',
  sagemaker:'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/us-east-1/index.json',
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE TYPES TO LOOK UP
//
// For each service, we look up a specific reference instance that represents
// the "default" recommendation Nimbo shows to users.
// ─────────────────────────────────────────────────────────────────────────────
const TARGET_INSTANCES = {
  ec2:      { instanceType: 't3.micro',    osFilter: 'Linux'     },
  rds:      { instanceType: 'db.t3.micro', osFilter: null        },
  fargate:  { instanceType: null,          osFilter: null        },
  sagemaker:{ instanceType: 'ml.t3.medium',osFilter: null        },
};

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK VALUES
//
// These are the same rough numbers currently hardcoded in index.html.
// They are only used if the AWS pricing endpoint is unreachable.
// The frontend will show "(estimated)" next to costs from fallback data.
// ─────────────────────────────────────────────────────────────────────────────
const FALLBACKS = {
  ec2:       { monthlyUSD: 8.47,  pricePerHour: 0.0116,  basis: 't3.micro on-demand, us-east-1'    },
  rds:       { monthlyUSD: 14.64, pricePerHour: 0.0202,  basis: 'db.t3.micro MySQL, us-east-1'     },
  s3:        { monthlyUSD: 2.30,  pricePerHour: 0.0031,  basis: '$0.023/GB, ~100 GB assumed'        },
  lambda:    { monthlyUSD: 0.20,  pricePerHour: 0.000028,basis: '1M reqs + 400K GB-s free tier'    },
  dynamodb:  { monthlyUSD: 1.25,  pricePerHour: 0.0017,  basis: 'on-demand, 25 GB free'            },
  fargate:   { monthlyUSD: 18.00, pricePerHour: 0.0249,  basis: '0.25 vCPU / 0.5 GB, us-east-1'   },
  amplify:   { monthlyUSD: 1.00,  pricePerHour: 0.0014,  basis: '5 GB hosting free tier'           },
  sagemaker: { monthlyUSD: 35.00, pricePerHour: 0.0464,  basis: 'ml.t3.medium notebook, us-east-1' },
  glue:      { monthlyUSD: 8.00,  pricePerHour: 0.0110,  basis: '$1/DPU-hour, 2 DPUs assumed'      },
};

// ─────────────────────────────────────────────────────────────────────────────
// CORS HEADERS
//
// These must be on every response so the browser allows the fetch() call.
// "Access-Control-Allow-Origin: *" means any website can call this endpoint.
// That is fine for a public pricing API — there is no sensitive data here.
// ─────────────────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=3600',  // browsers cache for 1 hour
};

// ─────────────────────────────────────────────────────────────────────────────
// PRICE EXTRACTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walks the raw AWS pricing JSON and finds the on-demand hourly USD price
 * for the given instance type.
 *
 * The AWS bulk pricing JSON has this rough shape:
 *   data.products[sku] = { attributes: { instanceType, operatingSystem, ... } }
 *   data.terms.OnDemand[sku][termKey].priceDimensions[dimKey].pricePerUnit.USD
 *
 * We scan products until we find one whose attributes match our target,
 * then follow the chain to the actual price number.
 */
function extractEC2Price(data, instanceType, osFilter) {
  for (const product of Object.values(data.products || {})) {
    const attr = product.attributes || {};
    if (
      attr.instanceType   === instanceType &&
      attr.operatingSystem === osFilter &&
      attr.tenancy         === 'Shared' &&
      attr.preInstalledSw  === 'NA' &&
      attr.capacitystatus  === 'Used'
    ) {
      const onDemandTerms = data.terms?.OnDemand?.[product.sku];
      if (!onDemandTerms) continue;
      const firstTerm = Object.values(onDemandTerms)[0];
      const firstDim  = Object.values(firstTerm?.priceDimensions || {})[0];
      const price = parseFloat(firstDim?.pricePerUnit?.USD ?? '0');
      if (price > 0) return price;
    }
  }
  return null;
}

/**
 * RDS pricing — similar structure but no operatingSystem/tenancy filters.
 * We match on instanceType and databaseEngine = "MySQL".
 */
function extractRDSPrice(data, instanceType) {
  for (const product of Object.values(data.products || {})) {
    const attr = product.attributes || {};
    if (
      attr.instanceType    === instanceType &&
      attr.databaseEngine  === 'MySQL' &&
      attr.deploymentOption === 'Single-AZ'
    ) {
      const onDemandTerms = data.terms?.OnDemand?.[product.sku];
      if (!onDemandTerms) continue;
      const firstTerm = Object.values(onDemandTerms)[0];
      const firstDim  = Object.values(firstTerm?.priceDimensions || {})[0];
      const price = parseFloat(firstDim?.pricePerUnit?.USD ?? '0');
      if (price > 0) return price;
    }
  }
  return null;
}

/**
 * S3 pricing — we look for the standard storage price per GB-month
 * and convert to an hourly rate (purely for consistency with other services).
 */
function extractS3Price(data) {
  for (const product of Object.values(data.products || {})) {
    const attr = product.attributes || {};
    if (
      attr.storageClass === 'General Purpose' &&
      attr.volumeType   === 'Standard' &&
      attr.location     === 'US East (N. Virginia)'
    ) {
      const onDemandTerms = data.terms?.OnDemand?.[product.sku];
      if (!onDemandTerms) continue;
      const firstTerm = Object.values(onDemandTerms)[0];
      const firstDim  = Object.values(firstTerm?.priceDimensions || {})[0];
      const pricePerGB = parseFloat(firstDim?.pricePerUnit?.USD ?? '0');
      if (pricePerGB > 0) {
        // Convert $/GB-month to $/hr assuming 100 GB of storage
        return (pricePerGB * 100) / (30.44 * 24);
      }
    }
  }
  return null;
}

/**
 * Lambda pricing — we look for the per-request price (not GB-seconds)
 * to give a representative hourly cost for ~100k requests/hour.
 */
function extractLambdaPrice(data) {
  for (const product of Object.values(data.products || {})) {
    const attr = product.attributes || {};
    if (
      attr.group       === 'AWS-Lambda-Requests' &&
      attr.location    === 'US East (N. Virginia)'
    ) {
      const onDemandTerms = data.terms?.OnDemand?.[product.sku];
      if (!onDemandTerms) continue;
      const firstTerm = Object.values(onDemandTerms)[0];
      const firstDim  = Object.values(firstTerm?.priceDimensions || {})[0];
      const pricePerReq = parseFloat(firstDim?.pricePerUnit?.USD ?? '0');
      if (pricePerReq > 0) {
        // $/request × 100,000 requests/hr = representative hourly cost
        return pricePerReq * 100_000;
      }
    }
  }
  return null;
}

/**
 * DynamoDB pricing — look for on-demand write request units
 * as the primary cost driver.
 */
function extractDynamoDBPrice(data) {
  for (const product of Object.values(data.products || {})) {
    const attr = product.attributes || {};
    if (
      attr.group    === 'DDB-WriteUnits' &&
      attr.location === 'US East (N. Virginia)'
    ) {
      const onDemandTerms = data.terms?.OnDemand?.[product.sku];
      if (!onDemandTerms) continue;
      const firstTerm = Object.values(onDemandTerms)[0];
      const firstDim  = Object.values(firstTerm?.priceDimensions || {})[0];
      const pricePerWRU = parseFloat(firstDim?.pricePerUnit?.USD ?? '0');
      if (pricePerWRU > 0) {
        // $per-WRU × 1M WRUs/hr = representative hourly cost for a moderate app
        return pricePerWRU * 1_000_000;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE DISPATCHER
//
// Routes each service ID to the right extraction function.
// Returns pricePerHour (number) or null if extraction failed.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLivePricePerHour(service) {
  const url = PRICING_URLS[service];
  if (!url) return null;

  // The bulk pricing files are large (EC2 is ~400 MB uncompressed).
  // We set a 10-second timeout — if AWS doesn't respond in time we fall back.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();

    switch (service) {
      case 'ec2':      return extractEC2Price(data, 't3.micro', 'Linux');
      case 'rds':      return extractRDSPrice(data, 'db.t3.micro');
      case 's3':       return extractS3Price(data);
      case 'lambda':   return extractLambdaPrice(data);
      case 'dynamodb': return extractDynamoDBPrice(data);
      default:         return null;
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
//
// This is the function AWS Lambda calls for every incoming request.
// API Gateway passes the HTTP event as the first argument.
//
// Event shape (HTTP API v2 from API Gateway):
//   event.queryStringParameters = { service: "ec2" }
//   event.requestContext.http.method = "GET"
// ─────────────────────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // Handle CORS pre-flight — browsers send OPTIONS before the real GET
  if (event?.requestContext?.http?.method === 'OPTIONS' ||
      event?.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  // Read the ?service= query parameter (default to ec2)
  const params = event?.queryStringParameters || {};
  const service = (params.service || 'ec2').toLowerCase().trim();

  // Validate the service name
  const validServices = Object.keys(FALLBACKS);
  if (!validServices.includes(service)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: `Unknown service: "${service}"`,
        validServices,
      }),
    };
  }

  const fallback = FALLBACKS[service];
  let pricePerHour = null;
  let source = 'aws-pricing-api';

  // Services without a live URL (amplify, glue) go straight to fallback
  if (!PRICING_URLS[service]) {
    pricePerHour = fallback.pricePerHour;
    source = 'fallback-no-bulk-endpoint';
  } else {
    try {
      pricePerHour = await fetchLivePricePerHour(service);
      if (pricePerHour === null) {
        // Parsing succeeded but no matching product found — use fallback
        pricePerHour = fallback.pricePerHour;
        source = 'fallback-parse-miss';
      }
    } catch (err) {
      // Network error, timeout, or JSON parse failure — use fallback
      pricePerHour = fallback.pricePerHour;
      source = `fallback-error:${err.message?.slice(0, 60)}`;
    }
  }

  // Convert hourly → monthly  (30.44 average days per month)
  const monthlyUSD = parseFloat((pricePerHour * 24 * 30.44).toFixed(4));

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      service,
      region:       'us-east-1',
      pricePerHour: parseFloat(pricePerHour.toFixed(6)),
      monthlyUSD,
      basis:        fallback.basis,
      source,
      cachedAt:     new Date().toISOString(),
    }),
  };
};
