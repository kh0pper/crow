// Import FIRST in a test that verifies remote actors in its own process right
// after it starts: servers/shared/remote-actor.js reads its post-boot grace at
// module load (testTunableMs, honoured only in the suite's scratch env), and a
// fresh test process is always inside the production one-minute grace.
process.env.CROW_TEST_REMOTE_ACTOR_BOOT_GRACE_MS = "250";
