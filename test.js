const _ = require('lodash');
const Promise = require('bluebird');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;
const sinon = require('sinon');
const redis = require('redis').createClient();
const DataLoader = require('dataloader');
const RedisDataLoader = require('./index.js')({ redis: redis });

describe('redis-dataloader', () => {
  beforeEach(() => {
    const rDel = key =>
      new Promise((resolve, reject) =>
        redis.del(key, (err, resp) => (err ? reject(err) : resolve(resp)))
      );

    this.rSet = (k, v) =>
      new Promise((resolve, reject) =>
        redis.set(k, v, (err, resp) => (err ? reject(err) : resolve(resp)))
      );

    this.keySpace = 'key-space';
    this.data = {
      json: { foo: 'bar' },
      null: null,
    };

    this.stubs = {};

    this.loadFn = sinon.stub();

    _.each(this.data, (v, k) => {
      this.loadFn.withArgs(k).returns(Promise.resolve(v));
    });

    this.userLoader = () =>
      new DataLoader(keys => Promise.map(keys, this.loadFn), {
        cache: false,
      });

    return Promise.map(_.keys(this.data), k =>
      rDel(`${this.keySpace}:${k}`)
    ).then(() => {
      this.loader = new RedisDataLoader(this.keySpace, this.userLoader());
      this.noCacheLoader = new RedisDataLoader(
        this.keySpace,
        this.userLoader(),
        { cache: false }
      );
    });
  });

  afterEach(() => {
    _.each(this.stubs, s => s.restore());
  });

  describe('load', () => {
    it('should load json value', () =>
      this.loader.load('json').then(data => {
        expect(data).to.deep.equal(this.data.json);
      }));

    it('should require key', () =>
      expect(this.loader.load()).to.be.rejectedWith(TypeError));

    it('should use local cache on second load', () => {
      this.stubs.redisMGet = sinon.stub(redis, 'mget', (keys, cb) => {
        cb(null, [JSON.stringify(this.data.json)]);
      });

      return this.loader
        .load('json')
        .then(data => {
          expect(this.loadFn.callCount).to.equal(0);
          expect(this.stubs.redisMGet.callCount).to.equal(1);
          return this.loader.load('json');
        })
        .then(data => {
          expect(this.loadFn.callCount).to.equal(0);
          expect(this.stubs.redisMGet.callCount).to.equal(1);
        });
    });

    it('should not use in memory cache if option is passed', () => {
      this.stubs.redisMGet = sinon.stub(redis, 'mget', (keys, cb) => {
        cb(null, [JSON.stringify(this.data.json)]);
      });

      return this.noCacheLoader
        .load('json')
        .then(data => {
          expect(this.loadFn.callCount).to.equal(0);
          expect(this.stubs.redisMGet.callCount).to.equal(1);
          return this.noCacheLoader.load('json');
        })
        .then(data => {
          expect(this.loadFn.callCount).to.equal(0);
          expect(this.stubs.redisMGet.callCount).to.equal(2);
        });
    });

    it('should load null values', () =>
      this.loader
        .load('null')
        .then(data => {
          expect(data).to.be.null;
          return this.loader.load('null');
        })
        .then(data => {
          expect(data).to.be.null;
        }));

    it('should handle redis cacheing of null values', () =>
      this.noCacheLoader
        .load('null')
        .then(data => {
          expect(data).to.be.null;
          return this.noCacheLoader.load('null');
        })
        .then(data => {
          expect(data).to.be.null;
        }));

    it('should handle redis key expiration if set', done => {
      const loader = new RedisDataLoader(this.keySpace, this.userLoader(), {
        cache: false,
        expire: 1,
      });

      loader
        .load('json')
        .then(data => {
          expect(data).to.deep.equal(this.data.json);
          setTimeout(() => {
            loader
              .load('json')
              .then(data => {
                expect(data).to.deep.equal(this.data.json);
                expect(this.loadFn.callCount).to.equal(2);
                done();
              })
              .done();
          }, 1100);
        })
        .catch(done)
        .done();
    });

    it('should handle custom serialize and deserialize method', () => {
      const loader = new RedisDataLoader(this.keySpace, this.userLoader(), {
        serialize: v => 100,
        deserialize: v => new Date(Number(v)),
      });

      return loader.load('json').then(data => {
        expect(data).to.be.instanceof(Date);
        expect(data.getTime()).to.equal(100);
      });
    });
  });

  describe('loadMany', () => {
    it('should load multiple keys', () =>
      this.loader.loadMany(['json', 'null']).then(results => {
        expect(results).to.deep.equal([this.data.json, this.data.null]);
      }));

    it('should handle empty array', () =>
      this.loader.loadMany([]).then(results => {
        expect(results).to.deep.equal([]);
      }));

    it('should require array', () =>
      expect(this.loader.loadMany()).to.be.rejectedWith(TypeError));
  });

  describe('prime', () => {
    it('should set cache', () =>
      this.loader
        .prime('json', { new: 'value' })
        .then(() => this.loader.load('json'))
        .then(data => {
          expect(data).to.deep.equal({ new: 'value' });
        }));

    it('should handle primeing without local cache', () =>
      this.noCacheLoader
        .prime('json', { new: 'value' })
        .then(() => this.noCacheLoader.load('json'))
        .then(data => {
          expect(data).to.deep.equal({ new: 'value' });
        }));

    it('should require key', () =>
      expect(this.loader.prime(undefined, { new: 'value' })).to.be.rejectedWith(
        TypeError
      ));

    it('should require value', () =>
      expect(this.loader.prime('json')).to.be.rejectedWith(TypeError));

    it('should allow null for value', () =>
      this.loader
        .prime('json', null)
        .then(() => this.loader.load('json'))
        .then(data => {
          expect(data).to.be.null;
        }));
  });

  describe('clear', () => {
    it('should clear cache', () =>
      this.loader
        .load('json')
        .then(() => this.loader.clear('json'))
        .then(() => this.loader.load('json'))
        .then(data => {
          expect(data).to.deep.equal(this.data.json);
          expect(this.loadFn.callCount).to.equal(2);
        }));

    it('should require a key', () =>
      expect(this.loader.clear()).to.be.rejectedWith(TypeError));
  });

  describe('clearAllLocal', () => {
    it('should clear all local in-memory cache', () =>
      this.loader
        .loadMany(['json', 'null'])
        .then(() => this.loader.clearAllLocal())
        .then(() =>
          this.rSet(`${this.keySpace}:json`, JSON.stringify({ new: 'valeo' }))
        )
        .then(() =>
          this.rSet(`${this.keySpace}:null`, JSON.stringify({ foo: 'bar' }))
        )
        .then(() => this.loader.loadMany(['null', 'json']))
        .then(data => {
          expect(data).to.deep.equal([{ foo: 'bar' }, { new: 'valeo' }]);
        }));
  });

  describe('clearLocal', () => {
    it('should clear local cache for a specific key', () =>
      this.loader
        .loadMany(['json', 'null'])
        .then(() => this.loader.clearLocal('json'))
        .then(() =>
          this.rSet(`${this.keySpace}:json`, JSON.stringify({ new: 'valeo' }))
        )
        .then(() =>
          this.rSet(`${this.keySpace}:null`, JSON.stringify({ foo: 'bar' }))
        )
        .then(() => this.loader.loadMany(['null', 'json']))
        .then(data => {
          expect(data).to.deep.equal([null, { new: 'valeo' }]);
        }));
  });
});
