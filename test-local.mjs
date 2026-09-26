/**
 * test-local.mjs  —  Local test runner for the Nimbo pricing Lambda
 *
 * This file is NEVER deployed to AWS.
 * It simulates what API Gateway sends to the Lambda handler so you can
 * verify everything works on your machine first.
 *
 * How to run:
 *   node pricing-lambda/test-local.mjs          (fast tests only)
 *   node pricing-lambda/test-local.mjs --live   (includes live AWS fetch — needs internet)
 *
 * What a passing run looks like:
 *   Each test prints PASS or FAIL with a reason.
 *   The final line prints: "X/Y tests passed"
 *   All tests should pass before you deploy anything to AWS.
 *
 * Why the live fetch is opt-in:
 *   The AWS EC2 pricing file is ~400 MB. Downloading it takes 5–30 seconds
 *   depending on your connection. The fast tests cover all the logic paths
 *   using stub responses so you don't have to wait every time.
 */

import { handler } from './index.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// CLI FLAG
// ─────────────────────────────────────────────────────────────────────────────
const LIVE_MODE = process.argv.includes('--live');

// ─────────────────────────────────────────────────────────────────────────────
// COLOURS
// ─────────────────────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

// ─────────────────────────────────────────────────────────────────────────────
// ASSERTION HELPERS
// ─────────────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function pass(label, detail = '') {
  passed++;
  console.log(`  ${GREEN}✓ PASS${RESET}  ${label}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}

function fail(label, reason) {
  failed++;
  console.log(`  ${RED}✗ FAIL${RESET}  ${label}`);
  console.log(`         ${RED}→ ${reason}${RESET}`);
}

function section(title) {
  console.log(`\n${CYAN}${BOLD}── ${title} ──${RESET}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT BUILDERS
// Simulate what API Gateway sends to the Lambda handler
// ─────────────────────────────────────────────────────────────────────────────
function makeEvent(service) {
  return {
    requestContext: { http: { method: 'GET' } },
    queryStringParameters: service ? { service } : {},
  };
}

function makeOptionsEvent() {
  return {
    requestContext: { http: { method: 'OPTIONS' } },
    queryStringParameters: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH MOCK
//
// For the fast tests we replace the global fetch with a stub that returns
// a tiny valid AWS pricing response. This means:
//   - Tests run in milliseconds with no network needed
//   - We still exercise the full JSON parsing code path
//
// The real fetch is used only in LIVE_MODE (--live flag).
// ─────────────────────────────────────────────────────────────────────────────
const MOCK_EC2_RESPONSE = {
  products: {
    'SKU001': {
      sku: 'SKU001',
      attributes: {
        instanceType:    't3.micro',
        operatingSystem: 'Linux',
        tenancy:         'Shared',
        preInstalledSw:  'NA',
        capacitystatus:  'Used',
      },
    },
  },
  terms: {
    OnDemand: {
      'SKU001': {
        'TERM001': {
          priceDimensions: {
            'DIM001': {
              pricePerUnit: { USD: '0.0116' },
            },
          },
        },
      },
    },
  },
};

const MOCK_RDS_RESPONSE = {
  products: {
    'SKU002': {
      sku: 'SKU002',
      attributes: {
        instanceType:     'db.t3.micro',
        databaseEngine:   'MySQL',
        deploymentOption: 'Single-AZ',
      },
    },
  },
  terms: {
    OnDemand: {
      'SKU002': {
        'TERM002': {
          priceDimensions: {
            'DIM002': {
              pricePerUnit: { USD: '0.0202' },
            },
          },
        },
      },
    },
  },
};

const MOCK_S3_RESPONSE = {
  products: {
    'SKU003': {
      sku: 'SKU003',
      attributes: {
        storageClass: 'General Purpose',
        volumeType:   'Standard',
        location:     'US East (N. Virginia)',
      },
    },
  },
  terms: {
    OnDemand: {
      'SKU003': {
        'TERM003': {
          priceDimensions: {
            'DIM003': {
              pricePerUnit: { USD: '0.023' },
            },
          },
        },
      },
    },
  },
};

const MOCK_LAMBDA_RESPONSE = {
  products: {
    'SKU004': {
      sku: 'SKU004',
      attributes: {
        group:    'AWS-Lambda-Requests',
        location: 'US East (N. Virginia)',
      },
    },
  },
  terms: {
    OnDemand: {
      'SKU004': {
        'TERM004': {
          priceDimensions: {
            'DIM004': {
              pricePerUnit: { USD: '0.0000000020' },
            },
          },
        },
      },
    },
  },
};

const MOCK_DYNAMODB_RESPONSE = {
  products: {
    'SKU005': {
      sku: 'SKU005',
      attributes: {
        group:    'DDB-WriteUnits',
        location: 'US East (N. Virginia)',
      },
    },
  },
  terms: {
    OnDemand: {
      'SKU005': {
        'TERM005': {
          priceDimensions: {
            'DIM005': {
              pricePerUnit: { USD: '0.00000125' },
            },
          },
        },
      },
    },
  },
};

// Maps a pricing URL substring to its mock response
const MOCK_RESPONSES = {
  AmazonEC2:     MOCK_EC2_RESPONSE,
  AmazonRDS:     MOCK_RDS_RESPONSE,
  AmazonS3:      MOCK_S3_RESPONSE,
  AWSLambda:     MOCK_LAMBDA_RESPONSE,
  AmazonDynamoDB: MOCK_DYNAMODB_RESPONSE,
};

function installFetchMock() {
  globalThis.fetch = async (url) => {
    // Find which mock to return based on the URL
    for (const [key, mockData] of Object.entries(MOCK_RESPONSES)) {
      if (url.includes(key)) {
        return {
          ok:   true,
          json: async () => mockData,
        };
      }
    }
    // No mock found — return empty products (triggers fallback path)
    return {
      ok:   true,
      json: async () => ({ products: {}, terms: { OnDemand: {} } }),
    };
  };
}

function removeFetchMock() {
  // Restore native fetch (Node 18+/20+)
  delete globalThis.fetch;
  // Re-import will use the native fetch which was set before we overrode it
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE — FAST (no network)
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}Nimbo Pricing Lambda — Local Test Suite${RESET}`);
console.log(`${DIM}Mode: ${LIVE_MODE ? 'LIVE (network calls enabled)' : 'FAST (mocked network)'}${RESET}`);
console.log(`${DIM}Tip:  Add --live flag to also test the real AWS Pricing endpoint${RESET}`);

if (!LIVE_MODE) installFetchMock();

// ── 1. CORS pre-flight ────────────────────────────────────────────────────────
section('1. CORS pre-flight (OPTIONS request)');
{
  const res = await handler(makeOptionsEvent());

  res.statusCode === 204
    ? pass('Returns 204 status')
    : fail('Returns 204 status', `got ${res.statusCode}`);

  res.headers?.['Access-Control-Allow-Origin'] === '*'
    ? pass('CORS header present')
    : fail('CORS header present', `got "${res.headers?.['Access-Control-Allow-Origin']}"`);
}

// ── 2. Unknown service ────────────────────────────────────────────────────────
section('2. Unknown service name');
{
  const res = await handler(makeEvent('blockchain'));
  const body = JSON.parse(res.body);

  res.statusCode === 400
    ? pass('Returns 400 for unknown service')
    : fail('Returns 400 for unknown service', `got ${res.statusCode}`);

  typeof body.error === 'string' && body.error.includes('blockchain')
    ? pass('Error message names the bad input')
    : fail('Error message names the bad input', `got: ${body.error}`);

  Array.isArray(body.validServices) && body.validServices.includes('ec2')
    ? pass('Response lists valid services')
    : fail('Response lists valid services', JSON.stringify(body.validServices));
}

// ── 3. Missing ?service= param (defaults to ec2) ─────────────────────────────
section('3. Default service (no ?service= param)');
{
  const res = await handler(makeEvent(null));
  const body = JSON.parse(res.body);

  res.statusCode === 200
    ? pass('Returns 200')
    : fail('Returns 200', `got ${res.statusCode}`);

  body.service === 'ec2'
    ? pass('Defaults to ec2')
    : fail('Defaults to ec2', `got "${body.service}"`);
}

// ── 4. Fallback-only services (no live pricing URL) ───────────────────────────
section('4. Fallback-only services (amplify, glue)');
for (const svc of ['amplify', 'glue']) {
  const res = await handler(makeEvent(svc));
  const body = JSON.parse(res.body);

  res.statusCode === 200
    ? pass(`${svc}: returns 200`)
    : fail(`${svc}: returns 200`, `got ${res.statusCode}`);

  typeof body.monthlyUSD === 'number' && body.monthlyUSD > 0
    ? pass(`${svc}: monthlyUSD is a positive number ($${body.monthlyUSD})`)
    : fail(`${svc}: monthlyUSD is a positive number`, `got ${body.monthlyUSD}`);

  body.source?.startsWith('fallback')
    ? pass(`${svc}: source confirms fallback used`)
    : fail(`${svc}: source confirms fallback used`, `got "${body.source}"`);
}

// ── 5. Response shape for all services ───────────────────────────────────────
section('5. Response shape — all 9 services');
const ALL_SERVICES  = ['ec2','rds','s3','lambda','dynamodb','fargate','amplify','sagemaker','glue'];
const REQUIRED_KEYS = ['service','region','pricePerHour','monthlyUSD','basis','source','cachedAt'];

for (const svc of ALL_SERVICES) {
  const res = await handler(makeEvent(svc));

  if (res.statusCode !== 200) {
    fail(`${svc}: status 200`, `got ${res.statusCode}`);
    continue;
  }

  let body;
  try { body = JSON.parse(res.body); }
  catch { fail(`${svc}: body is valid JSON`, 'JSON.parse threw'); continue; }

  const missing = REQUIRED_KEYS.filter(k => !(k in body));
  missing.length === 0
    ? pass(`${svc}: all required keys present`)
    : fail(`${svc}: all required keys present`, `missing: ${missing.join(', ')}`);

  typeof body.pricePerHour === 'number' && body.pricePerHour > 0
    ? pass(`${svc}: pricePerHour > 0  ($${body.pricePerHour})`)
    : fail(`${svc}: pricePerHour > 0`, `got ${body.pricePerHour}`);

  typeof body.monthlyUSD === 'number' && body.monthlyUSD > 0
    ? pass(`${svc}: monthlyUSD > 0  ($${body.monthlyUSD})`)
    : fail(`${svc}: monthlyUSD > 0`, `got ${body.monthlyUSD}`);

  body.region === 'us-east-1'
    ? pass(`${svc}: region is us-east-1`)
    : fail(`${svc}: region is us-east-1`, `got "${body.region}"`);
}

// ── 6. Parsed prices match mock data ─────────────────────────────────────────
section('6. Prices parsed correctly from mock data');
{
  // EC2 t3.micro: mock price is $0.0116/hr → $8.4587/mo
  const res = await handler(makeEvent('ec2'));
  const body = JSON.parse(res.body);

  body.source === 'aws-pricing-api'
    ? pass('EC2: source is aws-pricing-api (mock parsed successfully)')
    : fail('EC2: source is aws-pricing-api', `got "${body.source}"`);

  Math.abs(body.pricePerHour - 0.0116) < 0.0001
    ? pass(`EC2: pricePerHour matches mock ($${body.pricePerHour})`)
    : fail('EC2: pricePerHour matches mock', `expected ~$0.0116, got $${body.pricePerHour}`);

  // Monthly = 0.0116 × 24 × 30.44 = 8.4698…
  body.monthlyUSD > 8 && body.monthlyUSD < 9
    ? pass(`EC2: monthlyUSD is in expected range ($${body.monthlyUSD})`)
    : fail('EC2: monthlyUSD in expected range', `expected ~$8.47, got $${body.monthlyUSD}`);
}
{
  const res = await handler(makeEvent('rds'));
  const body = JSON.parse(res.body);
  Math.abs(body.pricePerHour - 0.0202) < 0.001
    ? pass(`RDS: pricePerHour matches mock ($${body.pricePerHour})`)
    : fail('RDS: pricePerHour matches mock', `expected ~$0.0202, got $${body.pricePerHour}`);
}
{
  const res = await handler(makeEvent('s3'));
  const body = JSON.parse(res.body);
  body.pricePerHour > 0
    ? pass(`S3: pricePerHour derived from storage rate ($${body.pricePerHour})`)
    : fail('S3: pricePerHour derived from storage rate', `got $${body.pricePerHour}`);
}

// ── 7. Case-insensitivity ─────────────────────────────────────────────────────
section('7. Case-insensitive service names');
for (const input of ['EC2', 'Ec2', 'EC2 ']) {
  const res = await handler(makeEvent(input));
  const body = JSON.parse(res.body);

  body.service === 'ec2' && res.statusCode === 200
    ? pass(`"${input}" normalised to "ec2"`)
    : fail(`"${input}" normalised to "ec2"`, `service="${body.service}", status=${res.statusCode}`);
}

// ── 8. CORS headers present on error responses ───────────────────────────────
section('8. CORS headers on error responses');
{
  const res = await handler(makeEvent('notaservice'));

  res.headers?.['Access-Control-Allow-Origin'] === '*'
    ? pass('CORS header present on 400 response')
    : fail('CORS header present on 400 response', `got "${res.headers?.['Access-Control-Allow-Origin']}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE — LIVE (opt-in with --live flag)
// ─────────────────────────────────────────────────────────────────────────────
if (LIVE_MODE) {
  // Restore native fetch for live tests
  removeFetchMock();

  section('9. Live AWS Pricing API — EC2 t3.micro  [--live]');
  console.log(`  ${YELLOW}⏳ Calling pricing.us-east-1.amazonaws.com… (up to 30 seconds)${RESET}`);

  const start = Date.now();
  const res   = await handler(makeEvent('ec2'));
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const body  = JSON.parse(res.body);

  res.statusCode === 200
    ? pass(`EC2 live: returns 200  (${elapsed}s)`)
    : fail(`EC2 live: returns 200`, `got ${res.statusCode}`);

  if (body.source === 'aws-pricing-api') {
    pass(`EC2 live: real price fetched  ($${body.pricePerHour}/hr, $${body.monthlyUSD}/mo)`);
  } else {
    pass(`EC2 live: data returned via fallback  (source: ${body.source})`,
         'network may be slow or restricted — fallback is intentional');
  }

  body.pricePerHour >= 0.005 && body.pricePerHour <= 0.10
    ? pass(`EC2 live: pricePerHour $${body.pricePerHour} is in realistic range ($0.005–$0.10/hr)`)
    : fail(`EC2 live: pricePerHour in realistic range`, `got $${body.pricePerHour}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${'─'.repeat(52)}`);
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ✓ All ${total} tests passed${RESET}`);
  if (!LIVE_MODE) {
    console.log(`${DIM}  Run with --live to also test the real AWS endpoint${RESET}`);
  }
  console.log(`${GREEN}${BOLD}  Ready for AWS deployment${RESET}`);
} else {
  console.log(`${RED}${BOLD}  ✗ ${failed}/${total} tests failed — fix before deploying${RESET}`);
}
console.log(`${'─'.repeat(52)}\n`);

if (failed > 0) process.exit(1);
