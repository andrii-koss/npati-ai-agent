/** Current input contract; schema.apply@1 remains in the versioned tool registry. */
export const CODE_DATA_SCHEMA_APPLY_V2_INPUT = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "operation",
    "expectedFingerprint",
    "expectedBackendId"
  ],
  "properties": {
    "expectedFingerprint": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    },
    "dryRun": {
      "type": "boolean"
    },
    "operation": {
      "oneOf": [
        {
          "type": "object",
          "required": [
            "kind",
            "collection"
          ],
          "additionalProperties": false,
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "create_collection",
                "add_field",
                "create_index"
              ]
            },
            "collection": {
              "type": "string",
              "minLength": 1,
              "maxLength": 63
            },
            "fields": {
              "type": "array",
              "items": {}
            },
            "field": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "name",
                "type"
              ],
              "properties": {
                "name": {
                  "type": "string"
                },
                "type": {
                  "type": "string",
                  "enum": [
                    "string",
                    "text",
                    "integer",
                    "decimal",
                    "boolean",
                    "date",
                    "datetime",
                    "json",
                    "uuid",
                    "enum",
                    "file_reference"
                  ]
                },
                "required": {
                  "type": "boolean"
                },
                "default": {
                  "type": [
                    "string",
                    "number",
                    "boolean",
                    "null"
                  ]
                },
                "options": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                }
              }
            },
            "unique": {
              "type": "boolean"
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "kind",
            "collection",
            "target",
            "name",
            "cardinality"
          ],
          "properties": {
            "kind": {
              "const": "create_relation"
            },
            "collection": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_]{0,62}$"
            },
            "target": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_]{0,62}$"
            },
            "name": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_]{0,62}$"
            },
            "field": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_]{0,62}$"
            },
            "onDelete": { "enum": ["cascade", "restrict", "set_null"], "description": "What happens to these rows when the referenced row is deleted. Use it whenever the request says so." },
            "cardinality": {
              "type": "string",
              "enum": [
                "many-to-one",
                "one-to-many",
                "many-to-many"
              ]
            }
          }
        }
      ]
    },
    "expectedBackendId": {
      "type": "string",
      "minLength": 1,
      "maxLength": 128
    }
  }
};
