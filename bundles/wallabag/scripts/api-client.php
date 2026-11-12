<?php
/**
 * Crow's OAuth client for Wallabag (manifest firstAdmin.setup.token).
 *
 * Wallabag's API is reached with an OAuth2 client, and this image's own
 * `fos:oauth-server:create-client` console command is broken (the Client it builds has no
 * user), so Crow creates the client itself through the app's own code: this program boots the
 * production kernel, finds the account by name and reuses that account's "Crow" client, or
 * creates it. Running it twice answers with the SAME public id and secret instead of piling up
 * clients (and instead of silently changing what the extension is set to use).
 *
 * It is piped into the container on stdin (`php -- <username>` reads this file from there) and
 * run as the app's own unprivileged user, exactly like scripts/first-admin.sh runs the console.
 * It reads NOTHING else: the account name is argv[1] (already validated as a plain account name
 * by scripts/api-token.sh), and no secret is ever passed to it — the admin password is only
 * used by that script's own proof against /oauth/v2/token.
 *
 * Output, one line, on stdout:
 *   CLIENT=<public id>:<secret>   the client exists and belongs to that account
 *   NOUSER                        Wallabag has no account of that name
 * Anything else (including a stderr diagnostic and exit 1) means no answer was given.
 */

require "/var/www/wallabag/vendor/autoload.php";
require "/var/www/wallabag/app/AppKernel.php";

$username = isset($argv[1]) ? (string) $argv[1] : "";
if ($username === "") {
    fwrite(STDERR, "no account name\n");
    exit(1);
}

$kernel = null;
try {
    $kernel = new AppKernel("prod", false);
    $kernel->boot();
    $entityManager = $kernel->getContainer()->get("doctrine")->getManager();

    $user = $entityManager
        ->getRepository("Wallabag\\UserBundle\\Entity\\User")
        ->findOneBy(array("username" => $username));
    if ($user === null) {
        print("NOUSER\n");
        $kernel->shutdown();
        exit(0);
    }

    $client = $entityManager
        ->getRepository("Wallabag\\ApiBundle\\Entity\\Client")
        ->findOneBy(array("user" => $user, "name" => "Crow"));
    if ($client === null) {
        $client = new \Wallabag\ApiBundle\Entity\Client($user);
        $client->setName("Crow");
        $client->setAllowedGrantTypes(array("password", "refresh_token"));
        $entityManager->persist($client);
        $entityManager->flush();
    }

    print("CLIENT=" . $client->getPublicId() . ":" . $client->getSecret() . "\n");
    $kernel->shutdown();
    exit(0);
} catch (\Throwable $e) {
    // Never the message: it can quote a database URL. The script answers "no usable answer".
    if ($kernel !== null) {
        try {
            $kernel->shutdown();
        } catch (\Throwable $ignored) {
            // nothing to do: the process is exiting anyway
        }
    }
    fwrite(STDERR, "the OAuth client could not be created\n");
    exit(1);
}