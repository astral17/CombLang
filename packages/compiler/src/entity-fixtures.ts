import type {
  EntityConnectorKey,
  EntityFeatureKey,
  EntityLaneKey,
  EntityProfile,
  EntityProfileId,
} from './entity.js';

const connector = (value: string): EntityConnectorKey => value as EntityConnectorKey;
const lane = (value: string): EntityLaneKey => value as EntityLaneKey;
const feature = (value: string): EntityFeatureKey => value as EntityFeatureKey;
const profile = (value: string): EntityProfileId => value as EntityProfileId;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const syntheticDatabase = {
  schemaVersion: 1,
  identity: 'comblang-synthetic-database-v1',
} as const;

/** A valid profile for an Entity that owns no physical connector. */
export const syntheticZeroPortEntityProfile: EntityProfile = deepFreeze({
  ref: {
    prototypeKey: 'entity:synthetic-zero-port',
    database: syntheticDatabase,
    profileId: profile('profile:synthetic-zero-port-v1'),
  },
  connectors: [],
  features: [],
  configurationRules: [],
  defaultReadProjection: null,
  synthetic: true,
});

/** A valid profile with one physical connector and explicit red/green endpoints. */
export const syntheticSharedTwoColorEntityProfile: EntityProfile = deepFreeze({
  ref: {
    prototypeKey: 'entity:synthetic-shared-two-color',
    database: syntheticDatabase,
    profileId: profile('profile:synthetic-shared-two-color-v1'),
  },
  connectors: [
    {
      key: connector('shared'),
      direction: 'bidirectional',
      lanes: [
        {
          key: lane('shared-red'),
          color: 'red',
          nativeEndpoint: {
            endpoint: { connector: connector('shared'), lane: lane('shared-red'), color: 'red' },
            nativeConnector: 1,
          },
        },
        {
          key: lane('shared-green'),
          color: 'green',
          nativeEndpoint: {
            endpoint: {
              connector: connector('shared'),
              lane: lane('shared-green'),
              color: 'green',
            },
            nativeConnector: 1,
          },
        },
      ],
    },
  ],
  features: [
    {
      key: feature('read'),
      connector: connector('shared'),
      defaultLane: lane('shared-red'),
      allowedLanes: [lane('shared-red'), lane('shared-green')],
    },
  ],
  configurationRules: [],
  defaultReadProjection: {
    feature: feature('read'),
    connector: connector('shared'),
    lane: lane('shared-red'),
  },
  synthetic: true,
});

/** Deliberately invalid: two physical connectors leave the selected feature ambiguous. */
export const syntheticAmbiguousMultiConnectorEntityProfile: EntityProfile = deepFreeze({
  ref: {
    prototypeKey: 'entity:synthetic-ambiguous-multi-connector',
    database: syntheticDatabase,
    profileId: profile('profile:synthetic-ambiguous-multi-connector-v1'),
  },
  connectors: [
    {
      key: connector('left'),
      direction: 'input',
      lanes: [
        { key: lane('left-red'), color: 'red' },
        { key: lane('left-green'), color: 'green' },
      ],
    },
    {
      key: connector('right'),
      direction: 'input',
      lanes: [{ key: lane('right-green'), color: 'green' }],
    },
  ],
  features: [
    {
      key: feature('read'),
      connector: connector('left'),
      allowedLanes: [lane('left-red'), lane('left-green')],
    },
  ],
  configurationRules: [],
  defaultReadProjection: null,
  synthetic: true,
});
