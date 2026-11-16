# Third-party notices — pm-workspace drawing editor

The drawing note editor vendors two JavaScript libraries into this directory
instead of loading them from a CDN: the gateway's Content-Security-Policy is
`script-src 'self' 'unsafe-inline'`, so an off-origin script is blocked and the
editor cannot boot. Each file is a byte-identical copy of the pinned upstream
release, served from `/pm/static/` and verified in the page with a Subresource
Integrity (`integrity`) hash. Both are MIT-licensed; their notices follow.

---

## fabric.js 5.3.1

- File: `fabric-5.3.1.min.js`
- Version: 5.3.1 (pinned)
- Upstream: https://fabricjs.com/ — https://github.com/fabricjs/fabric.js
- License: MIT

```
MIT License

Copyright (c) Printio (Juriy Zaytsev, Maxim Chernyak)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## perfect-freehand 1.2.2

- File: `perfect-freehand-1.2.2.js` (ESM build, no imports of its own)
- Version: 1.2.2 (pinned)
- Upstream: https://github.com/steveruizok/perfect-freehand
- License: MIT

```
MIT License

Copyright (c) Stephen Ruiz Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```