/**
 * Nimbo Pricing Lambda
 * ---------------------------------------------------------
 * Replaces the frontend's static costRange heuristic with a
 * real lookup against the AWS Price List Query API
 * (https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html)
 *
 * The Price List API only has public endpoints in us-east-1
 * and ap-south-1, so the Pricing client below is pinned to
 * us-east-1 regardless of which region this Lambda is deployed in.
 *
 * Request body (POST):
 *   { "serviceId": "ec2", "scale": "small" | "medium" | "large", "region": "us-east-1" }
 *
 * Response:
 *   { "monthly": 27.45, "source": "live", "unit": "t3.small, Linux, On-Demand", "region": "us-east-1" }
 *   or, for services we don't map yet:
 *   { "monthly": null, "source": "unsupported" }
 */

const { PricingClient, GetProductsCommand } = require("@aws-sdk/client-pricing");

const pricing = new PricingClient({ region: "us-east-1" });

// AWS Price List "location" strings keyed by common region codes.
// Extend this as you add more regions.
const LOCATION = {
  "us-east-1": "US East (N. Virginia)",
  "us-west-2": "US West (Oregon)",
  "eu-west-1": "Europe (Ireland)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
};

const HOURS_PER_MONTH = 730;

// Scale tiers mirror the same "small / medium / large" logic the
// frontend already uses in estMo(), just now backed by real SKUs.
const SCALE_MAP = {
  ec2: {
    small: { instanceType: "t3.micro" },
    medium: { instanceType: "t3.small" },
    large: { instanceType: "t3.medium" },
  },
  rds: {
    small: { instanceType: "db.t3.micro" },
    medium: { instanceType: "db.t3.small" },
    large: { instanceType: "db.t3.medium" },
  },
  fargate: {
    // vCPU-hours; combined with a fixed GB-hours ratio below
    small: { vcpu: 0.25, gbRatio: 0.5 },
    medium: { vcpu: 0.5, gbRatio: 1 },
    large: { vcpu: 1, gbRatio: 2 },
  },
  s3: {
    small: { gb: 5 },
    medium: { gb: 50 },
    large: { gb: 500 },
  },
  lambda: {
    small: { invocations: 100000, gbSeconds: 20000 },
    medium: { invocations: 1000000, gbSeconds: 200000 },
    large: { invocations: 10000000, gbSeconds: 2000000 },
  },
  dynamodb: {
    small: { readUnits: 5, writeUnits: 5 },
    medium: { readUnits: 25, writeUnits: 25 },
    large: { readUnits: 100, writeUnits: 100 },
  },
};

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const serviceId = body.serviceId;
    const scale = ["small", "medium", "large"].includes(body.scale) ? body.scale : "small";
    const region = LOCATION[body.region] ? body.region : "us-east-1";

    if (!SCALE_MAP[serviceId]) {
      return { statusCode: 200, headers, body: JSON.stringify({ monthly: null, source: "unsupported" }) };
    }

    const result = await priceFor(serviceId, scale, region);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 200, // degrade gracefully — the frontend falls back to its own estimate
      headers,
      body: JSON.stringify({ monthly: null, source: "error", message: err.message }),
    };
  }
};

async function priceFor(serviceId, scale, region) {
  const location = LOCATION[region];
  switch (serviceId) {
    case "ec2":
      return ec2Price(scale, location, region);
    case "rds":
      return rdsPrice(scale, location, region);
    case "s3":
      return s3Price(scale, location, region);
    case "fargate":
      return fargatePrice(scale, location, region);
    case "lambda":
      return lambdaPrice(scale, region);
    case "dynamodb":
      return dynamoPrice(scale, region);
    default:
      return { monthly: null, source: "unsupported" };
  }
}

async function firstPrice(serviceCode, filters) {
  const cmd = new GetProductsCommand({
    ServiceCode: serviceCode,
    Filters: filters.map((f) => ({ Type: "TERM_MATCH", Field: f.field, Value: f.value })),
    MaxResults: 5,
  });
  const res = await pricing.send(cmd);
  if (!res.PriceList || res.PriceList.length === 0) return null;
  const product = JSON.parse(res.PriceList[0]);
  const onDemand = Object.values(product.terms?.OnDemand || {})[0];
  if (!onDemand) return null;
  const priceDims = Object.values(onDemand.priceDimensions || {})[0];
  if (!priceDims) return null;
  return { pricePerUnit: parseFloat(priceDims.pricePerUnit.USD), description: priceDims.description };
}

async function ec2Price(scale, location, region) {
  const { instanceType } = SCALE_MAP.ec2[scale];
  const p = await firstPrice("AmazonEC2", [
    { field: "instanceType", value: instanceType },
    { field: "operatingSystem", value: "Linux" },
    { field: "tenancy", value: "Shared" },
    { field: "preInstalledSw", value: "NA" },
    { field: "capacitystatus", value: "Used" },
    { field: "location", value: location },
  ]);
  if (!p) return { monthly: null, source: "unsupported" };
  return { monthly: round(p.pricePerUnit * HOURS_PER_MONTH), source: "live", unit: `${instanceType}, Linux On-Demand`, region };
}

async function rdsPrice(scale, location, region) {
  const { instanceType } = SCALE_MAP.rds[scale];
  const p = await firstPrice("AmazonRDS", [
    { field: "instanceType", value: instanceType },
    { field: "databaseEngine", value: "MySQL" },
    { field: "deploymentOption", value: "Single-AZ" },
    { field: "location", value: location },
  ]);
  if (!p) return { monthly: null, source: "unsupported" };
  return { monthly: round(p.pricePerUnit * HOURS_PER_MONTH), source: "live", unit: `${instanceType}, MySQL Single-AZ`, region };
}

async function s3Price(scale, location, region) {
  const { gb } = SCALE_MAP.s3[scale];
  const p = await firstPrice("AmazonS3", [
    { field: "storageClass", value: "General Purpose" },
    { field: "volumeType", value: "Standard" },
    { field: "location", value: location },
  ]);
  if (!p) return { monthly: null, source: "unsupported" };
  return { monthly: round(p.pricePerUnit * gb), source: "live", unit: `${gb} GB Standard storage`, region };
}

async function fargatePrice(scale, location, region) {
  const { vcpu, gbRatio } = SCALE_MAP.fargate[scale];
  const regionPrefix = { "us-east-1": "USE1", "us-west-2": "USW2", "eu-west-1": "EUW1", "ap-southeast-1": "APS1" }[region] || "USE1";
  const [vcpuP, gbP] = await Promise.all([
    firstPrice("AmazonECS", [
      { field: "location", value: location },
      { field: "usagetype", value: `${regionPrefix}-Fargate-vCPU-Hours:perCPU` },
    ]),
    firstPrice("AmazonECS", [
      { field: "location", value: location },
      { field: "usagetype", value: `${regionPrefix}-Fargate-GB-Hours` },
    ]),
  ]);
  if (!vcpuP || !gbP) return { monthly: null, source: "unsupported" };
  const monthly = vcpuP.pricePerUnit * vcpu * HOURS_PER_MONTH + gbP.pricePerUnit * vcpu * gbRatio * HOURS_PER_MONTH;
  return { monthly: round(monthly), source: "live", unit: `${vcpu} vCPU task, always-on`, region };
}

async function lambdaPrice(scale, region) {
  const { invocations, gbSeconds } = SCALE_MAP.lambda[scale];
  const p = await firstPrice("AWSLambda", [{ field: "group", value: "AWS-Lambda-Duration" }]);
  const reqP = await firstPrice("AWSLambda", [{ field: "group", value: "AWS-Lambda-Requests" }]);
  if (!p || !reqP) return { monthly: null, source: "unsupported" };
  const freeGbS = 400000, freeReq = 1000000;
  const billableGbS = Math.max(0, gbSeconds - freeGbS);
  const billableReq = Math.max(0, invocations - freeReq);
  const monthly = billableGbS * p.pricePerUnit + billableReq * reqP.pricePerUnit;
  return { monthly: round(monthly), source: "live", unit: `${invocations.toLocaleString()} invocations/mo`, region };
}

async function dynamoPrice(scale, region) {
  const { readUnits, writeUnits } = SCALE_MAP.dynamodb[scale];
  // On-demand mode: priced per million read/write request units.
  const readP = await firstPrice("AmazonDynamoDB", [{ field: "group", value: "DDB-ReadUnits" }]);
  const writeP = await firstPrice("AmazonDynamoDB", [{ field: "group", value: "DDB-WriteUnits" }]);
  if (!readP || !writeP) return { monthly: null, source: "unsupported" };
  const monthlyReads = readUnits * HOURS_PER_MONTH * 3600; // rough req/mo from steady RCU
  const monthlyWrites = writeUnits * HOURS_PER_MONTH * 3600;
  const monthly = (monthlyReads / 1e6) * readP.pricePerUnit + (monthlyWrites / 1e6) * writeP.pricePerUnit;
  return { monthly: round(monthly), source: "live", unit: `${readUnits} RCU / ${writeUnits} WCU (on-demand)`, region };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
