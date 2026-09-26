/**
 * Nimbo Pricing Lambda  —  index.console.mjs
 *
 * THIS IS THE VERSION TO PASTE INTO THE AWS CONSOLE.
 *
 * The only difference from index.mjs is the last line:
 *   index.mjs uses:          export const handler = async (event) => { ... }
 *   This file uses:          export const handler = async (event) => { ... }
 *
 * Both are ES module syntax. The AWS Console supports ES modules when:
 *   - The runtime is Node.js 20.x
 *   - The file is named index.mjs  (we will rename it in the Console)
 *
 * So this file is identical to index.mjs — it is here purely as
 * a clean copy to paste, with a clear label so you know which file to use.
 *
 * DO NOT deploy test-local.mjs — that file is only for local testing.
 */

const PRICING_URLS = {
  ec2:       'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json',
  rds:       'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json',
  s3:        'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json',
  lambda:    'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSLambda/current/us-east-1/index.json',
  dynamodb:  'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonDynamoDB/current/us-east-1/index.json',
  fargate:   'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/us-east-1/index.json',
  sagemaker: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSageMaker/current/us-east-1/index.json',
};

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

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=3600',
};

function extractEC2Price(data, instanceType, osFilter) {
  for (const product of Object.values(data.products || {})) {
    const attr = product.attributes || {};
    if (
      attr.instanceType    === instanceType &&
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

function extractRDSPrice(data, instanceType) {
  for (const product of Object.values(data.products || {})) {
    const attr = product.attributes || {};
    if (
      attr.instanceType     === instanceType &&
      attr.databaseEngine   === 'MySQL' &&
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
        return (pricePerGB * 100) / (30.44 * 24);
      }
    }
  }
  return null;
}

function extractLambdaPrice(data) {
  for (const product of Object.values(data.products || {})) {
    const attr = product.attributes || {};
    if (
      attr.group    === 'AWS-Lambda-Requests' &&
      attr.location === 'US East (N. Virginia)'
    ) {
      const onDemandTerms = data.terms?.OnDemand?.[product.sku];
      if (!onDemandTerms) continue;
      const firstTerm = Object.values(onDemandTerms)[0];
      const firstDim  = Object.values(firstTerm?.priceDimensions || {})[0];
      const pricePerReq = parseFloat(firstDim?.pricePerUnit?.USD ?? '0');
      if (pricePerReq > 0) return pricePerReq * 100_000;
    }
  }
  return null;
}

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
      if (pricePerWRU > 0) return pricePerWRU * 1_000_000;
    }
  }
  return null;
}

async function fetchLivePricePerHour(service) {
  const url = PRICING_URLS[service];
  if (!url) return null;

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

export const handler = async (event) => {
  if (event?.requestContext?.http?.method === 'OPTIONS' ||
      event?.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const params  = event?.queryStringParameters || {};
  const service = (params.service || 'ec2').toLowerCase().trim();

  const validServices = Object.keys(FALLBACKS);
  if (!validServices.includes(service)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Unknown service: "${service}"`, validServices }),
    };
  }

  const fallback = FALLBACKS[service];
  let pricePerHour = null;
  let source = 'aws-pricing-api';

  if (!PRICING_URLS[service]) {
    pricePerHour = fallback.pricePerHour;
    source = 'fallback-no-bulk-endpoint';
  } else {
    try {
      pricePerHour = await fetchLivePricePerHour(service);
      if (pricePerHour === null) {
        pricePerHour = fallback.pricePerHour;
        source = 'fallback-parse-miss';
      }
    } catch (err) {
      pricePerHour = fallback.pricePerHour;
      source = `fallback-error:${err.message?.slice(0, 60)}`;
    }
  }

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
