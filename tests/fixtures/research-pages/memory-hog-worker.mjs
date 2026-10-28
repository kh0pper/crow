// Fixture worker that allocates without bound until its resourceLimits kill it.
const hog = [];
for (;;) hog.push(new Array(1e6).fill({ x: Math.random() }));
