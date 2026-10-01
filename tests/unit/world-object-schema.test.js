import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

function compile(name) {
  const schema = JSON.parse(fs.readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  return ajv.compile(schema);
}

const validateObject = compile('world-object');
const validateVersion = compile('object-version');
const validateContribution = compile('object-contribution');
const validateLicense = compile('object-license');

const ids = {
  object: '00000000-0000-4000-8000-000000000101',
  version1: '00000000-0000-4000-8000-000000000102',
  version2: '00000000-0000-4000-8000-000000000103',
  creator: '00000000-0000-4000-8000-000000000104',
  contributor: '00000000-0000-4000-8000-000000000105',
  contribution: '00000000-0000-4000-8000-000000000106',
  license: '00000000-0000-4000-8000-000000000107',
};

const digest = `sha256:${'a'.repeat(64)}`;

function objectFixture(overrides = {}) {
  return {
    schema_version: 'nh.v3.0',
    object_id: ids.object,
    world_id: 'world-1',
    object_type: 'document',
    created_by_entity_id: ids.creator,
    control_ref: 'm01:capability-grant:object-101',
    current_version_id: ids.version1,
    version: 1,
    lifecycle_status: 'PUBLISHED',
    ...overrides,
  };
}

function versionFixture(overrides = {}) {
  return {
    schema_version: 'nh.v3.0',
    object_version_id: ids.version1,
    object_id: ids.object,
    version: 1,
    parent_version_id: null,
    content_ref: 'artifact://objects/101/versions/1',
    content_digest: digest,
    author_entity_id: ids.creator,
    created_at: '2026-10-01T06:00:00Z',
    ...overrides,
  };
}

test('WorldObject and ObjectVersion require positive explicit versions', () => {
  assert.equal(validateObject(objectFixture()), true, JSON.stringify(validateObject.errors));
  assert.equal(validateObject(objectFixture({ version: 0 })), false);

  assert.equal(validateVersion(versionFixture()), true, JSON.stringify(validateVersion.errors));
  assert.equal(validateVersion(versionFixture({ version: 0 })), false);
  assert.equal(validateVersion(versionFixture({ version: 2, object_version_id: ids.version2, parent_version_id: null })), false);
  assert.equal(validateVersion(versionFixture({ version: 2, object_version_id: ids.version2, parent_version_id: ids.version1 })), true, JSON.stringify(validateVersion.errors));
});

test('ObjectVersion carries content by reference and rejects inline object content', () => {
  assert.equal(validateVersion(versionFixture()), true, JSON.stringify(validateVersion.errors));

  const missingRef = versionFixture();
  delete missingRef.content_ref;
  assert.equal(validateVersion(missingRef), false);

  assert.equal(validateVersion(versionFixture({ content_ref: '' })), false);
  assert.equal(validateVersion(versionFixture({ content_digest: 'sha256:not-a-digest' })), false);
  assert.equal(validateVersion({ ...versionFixture(), content: { text: 'inline payload is not part of this contract' } }), false);
});

test('WorldObject rejects caller-supplied owner identity and keeps authority as references', () => {
  assert.equal(validateObject(objectFixture()), true, JSON.stringify(validateObject.errors));
  assert.equal(validateObject({ ...objectFixture(), owner: ids.creator }), false);
  assert.equal(validateObject({ ...objectFixture(), owner_entity_id: ids.creator }), false);
  assert.equal(validateObject(objectFixture({ created_by_entity_id: { entity_id: ids.creator, name: 'forged identity' } })), false);
});

test('contribution and license schemas reference authoritative entities without embedding owners', () => {
  const contribution = {
    schema_version: 'nh.v3.0',
    contribution_id: ids.contribution,
    object_id: ids.object,
    object_version_id: ids.version1,
    contributor_entity_id: ids.contributor,
    contribution_kind: 'AUTHOR',
    created_at: '2026-10-01T06:00:00Z',
  };
  assert.equal(validateContribution(contribution), true, JSON.stringify(validateContribution.errors));
  assert.equal(validateContribution({ ...contribution, owner: ids.creator }), false);

  const license = {
    schema_version: 'nh.v3.0',
    license_ref_id: ids.license,
    object_id: ids.object,
    object_version_id: ids.version1,
    license_expression: 'CC-BY-4.0',
    granted_by_entity_id: ids.creator,
    permissions: ['READ', 'USE', 'REDISTRIBUTE'],
    effective_at: '2026-10-01T06:00:00Z',
  };
  assert.equal(validateLicense(license), true, JSON.stringify(validateLicense.errors));
  assert.equal(validateLicense({ ...license, owner: ids.creator }), false);
});
