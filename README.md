# cache-dns
[![Build Status](https://github.com/jamiees2/cache-dns/actions/workflows/main.yml/badge.svg)](https://github.com/jamiees2/cache-dns/actions)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Docs](https://img.shields.io/badge/Docs-latest-informational)](https://ggithub.com/jamiees2/cache-dns/)

DNS caching implementation for Node.js. Provides same API as [`dns.lookup`](https://nodejs.org/api/dns.html#dnslookuphostname-options-callback)

[![NPM](https://nodeico.herokuapp.com/cache-dns.svg)](https://npmjs.com/package/cache-dns)

## Install
    $ npm install cache-dns

## Usage

The `lookup` function provided by this library has the same API signature as [`dns.lookup`](https://nodejs.org/api/dns.html#dnslookuphostname-options-callback). 
It supports all options, although `options.verbatim` is redundant, since the resolver will resolve ipv4 and ipv6 addresses separately, and join them together inside Node.js.

Additionally, the library exposes a `lookupPromise` function, which has the same API signature as [`dns.promises.lookup`](https://nodejs.org/api/dns.html#dnspromiseslookuphostname-options).

You can either use this manually, by passing the lookup function to functions that support it.

```js
const lookup = require("cache-dns").lookup
http.get({
    hostname: 'google.com', 
    path: '/',
    lookup: lookup
}, (res) => {
    console.log('RESPONSE', res.statusCode)
}).on('error', (err) => {
    console.error('ERROR', err)
})
```

Alternatively, you can tell the library to overwrite the `dns` module's `lookup` function, with this implementation. This makes it easier to patch existing code, but is dangerous.

```js
const cacheDNS = require("cache-dns")
cacheDNS.patchDnsLookup()

// this will now get cached by default
http.get({
    hostname: 'google.com', 
    path: '/',
}, (res) => {
    console.log('RESPONSE', res.statusCode)
}).on('error', (err) => {
    console.error('ERROR', err)
})
```