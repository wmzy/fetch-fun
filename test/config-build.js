import {setUrl, url, baseUrl, method} from '../src';
import {pipe} from '../src/util';

describe('config-build', function() {
  it('setUrl', function() {
    setUrl('https://x.y')({}).should.be.eql({url: 'https://x.y'});
  });

  it('url', function() {
    url('https://x.y')({}).should.be.eql({url: 'https://x.y'});

    pipe(
      url('/x'),
      url('/y')
    ).should.be.eql({
      url: '/y'
    });

    pipe(
      url('/x/'),
      url('http://x.y')
    ).should.be.eql({
      url: 'http://x.y'
    });

    pipe(
      url('/x/'),
      url('y')
    ).should.be.eql({
      url: '/x/y'
    });
  });

  it('baseUrl', function() {
    baseUrl('https://x.y')({}).should.be.eql({
      baseUrl: 'https://x.y'
    });
  });

  it('method', function() {
    method('get')({}).should.be.eql({method: 'get'});
  });
});
