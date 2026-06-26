"use strict";

const swaggerJsdoc = require("swagger-jsdoc");
const path = require("path");

/**
 * Auto-generates the OpenAPI spec from JSDoc annotations on the route files.
 */
const spec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "AXIS AI Marketplace API",
      version: "1.0.0",
      description:
        "Decentralized AI compute marketplace: model registry, compute jobs, TX capacity exchange, pricing engine, escrow and reputation.",
    },
    tags: [
      { name: "Models" },
      { name: "Jobs" },
      { name: "Capacity" },
      { name: "Pricing" },
      { name: "Reputation" },
    ],
  },
  apis: [path.join(__dirname, "routes", "*.js")],
});

module.exports = spec;
