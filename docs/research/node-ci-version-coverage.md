# Node.js CI version coverage

_Date checked: 2026-07-12_

## Conclusion

Node.js 22 and 24 are enough for the **required** CI matrix today. They are the two supported LTS lines and match this package's declared `node >=22` floor. Do not add Node 20 or Node 25. Node 26 can be added as an optional early-warning job while it is Current; make it required when it reaches LTS.

## Evidence

- This package declares [`engines.node: ">=22"`](../../package.json). Its CI runs full release validation and the oldest supported Prettier (`3.0.0`) on Node 22, while Node 24 covers the newer LTS line and latest Prettier 3. This is a useful minimum/latest split rather than redundant coverage.
- The [official Node.js release table](https://nodejs.org/en/about/previous-releases) lists Node 22 and 24 as LTS, Node 26 as Current, and Node 20 and 25 as EOL. It also advises production applications to use Active LTS or Maintenance LTS releases.
- Historically through Node 26, odd-numbered releases become unsupported after six months and even-numbered releases proceed to LTS. Starting with Node 27, every annual major will eventually become LTS, so the durable policy should be based on lifecycle status—not odd versus even numbering. See the [Node.js release policy](https://nodejs.org/en/about/previous-releases) and [Release Working Group schedule](https://github.com/nodejs/Release#release-schedule).
- GitHub documents a [`strategy.matrix` with `setup-node`](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs#testing-with-multiple-versions-of-nodejs) for testing multiple Node versions, but does not prescribe which versions a library must support.
- Comparable plugin repositories show there is no universal matrix:
  - [`prettier-plugin-svelte`](https://github.com/sveltejs/prettier-plugin-svelte/blob/main/package.json) declares Node `>=20` but its [CI](https://github.com/sveltejs/prettier-plugin-svelte/blob/main/.github/workflows/ci.yml) currently uses Node 24 only.
  - [`prettier-plugin-jinja-template`](https://github.com/davidodenwald/prettier-plugin-jinja-template/blob/master/.github/workflows/node.js.yml) tests Node 20, 22, and 24, but does not declare a Node engine floor in its [package metadata](https://github.com/davidodenwald/prettier-plugin-jinja-template/blob/master/package.json).

## Recommended policy

1. Test every non-EOL LTS major within `engines.node`.
2. Run the most comprehensive/package-boundary checks on the oldest supported major.
3. Run ordinary tests on newer LTS majors.
4. Optionally test Current Node as non-blocking early warning.
5. Review the matrix when Node's lifecycle changes, adding a Current release when it becomes LTS and removing an EOL release only after raising the package's engine floor.

Applied now:

- **Node 22:** required; release validation and minimum Prettier compatibility.
- **Node 24:** required; tests and latest Prettier compatibility.
- **Node 26:** optional while Current; required once LTS.
- **Node 20/25:** omit because they are EOL (and Node 20 is outside the declared range).

One nuance: `>=22` also accepts future and Current majors, although CI cannot exhaustively test every matching version. If the project intends to support only LTS releases, document that lifecycle policy alongside the semver engine declaration.
