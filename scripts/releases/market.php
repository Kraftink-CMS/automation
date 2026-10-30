<?php

function marketText(mixed $value, int $maximum): string
{
    if (!is_string($value) || trim($value) === '' || !preg_match('//u', $value)) {
        throw new RuntimeException('Market text must be valid nonempty UTF-8.');
    }
    if (preg_match_all('/./us', $value) > $maximum) {
        throw new RuntimeException('Market text exceeds its allowed length.');
    }

    return $value;
}

function marketUrl(mixed $value): string
{
    $parts = is_string($value) ? parse_url($value) : false;
    if (
        !$parts ||
        strlen($value) > 2048 ||
        !preg_match('~^https://(?:\[[^\]]+\]|[^/:?#]+)(?:/|$)~i', $value) ||
        preg_match('/[\x00-\x20\x7f"\'<>`\\\\?#]/', $value) ||
        !filter_var($value, FILTER_VALIDATE_URL) ||
        ($parts['scheme'] ?? null) !== 'https' ||
        empty($parts['host']) ||
        isset($parts['user']) ||
        isset($parts['pass']) ||
        isset($parts['port']) ||
        isset($parts['query']) ||
        isset($parts['fragment'])
    ) {
        throw new RuntimeException('Market links require plain HTTPS URLs.');
    }

    return $value;
}

function marketImage(mixed $value, string $directory, string $repository, mixed $version): string
{
    if (is_string($value) && preg_match('/^https:/i', $value)) {
        return marketUrl($value);
    }
    if (
        !is_string($value) ||
        strlen($value) > 2048 ||
        !preg_match('~^(?:[A-Za-z0-9][A-Za-z0-9._-]*/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif|avif)$~iD', $value)
    ) {
        throw new RuntimeException('Market images require a safe path inside resources/market or a plain HTTPS URL.');
    }
    if (!is_string($version) || !preg_match('/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/D', $version)) {
        throw new RuntimeException('Repository market images require a stable staged package version.');
    }
    $relative = str_starts_with($value, 'resources/market/') ? substr($value, strlen('resources/market/')) : $value;
    $base = realpath($directory.'/resources/market');
    if (!$base || is_link($directory.'/resources') || is_link($directory.'/resources/market')) {
        throw new RuntimeException('The market image directory is missing or unsafe.');
    }
    $path = $directory.'/resources/market';
    $segments = explode('/', $relative);
    foreach ($segments as $segment) {
        $path .= '/'.$segment;
        if (is_link($path)) {
            throw new RuntimeException('Market image paths cannot contain symbolic links.');
        }
    }
    $resolved = realpath($path);
    if (!$resolved || !is_file($path) || !str_starts_with($resolved, $base.DIRECTORY_SEPARATOR)) {
        throw new RuntimeException('The market image file is missing or unsafe.');
    }

    return marketUrl('https://raw.githubusercontent.com/'.$repository.'/v'.$version.'/resources/market/'.implode('/', array_map('rawurlencode', $segments)));
}

function marketValues(mixed $value, callable $validate): string|array
{
    if (is_string($value)) {
        return $validate($value);
    }
    if (!is_array($value) || $value === [] || count($value) > 100) {
        throw new RuntimeException('Market values require text or a nonempty language dictionary.');
    }
    foreach ($value as $locale => $entry) {
        if (!is_string($locale) || strlen($locale) > 35 || !preg_match('/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/D', $locale)) {
            throw new RuntimeException('Invalid market translation language.');
        }
        $value[$locale] = $validate($entry);
    }
    ksort($value);

    return $value;
}

function marketTranslations(mixed $text, string $slug, string $directory, array $locales, int $maximum): string|array
{
    if (is_array($text)) {
        return marketValues($text, static fn (mixed $value): string => marketText($value, $maximum));
    }
    marketText($text, $maximum);
    if (!str_contains($text, '::')) {
        return $text;
    }
    if (
        !preg_match('/^([a-z][a-z0-9-]{1,49})::([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/D', $text, $match) ||
        $match[1] !== $slug
    ) {
        throw new RuntimeException('Market translation keys must belong to the package.');
    }
    $translated = [];
    foreach ($locales as $locale) {
        $path = $directory.'/lang/'.$locale.'/'.$match[2].'.php';
        if (!is_file($path)) {
            continue;
        }
        ob_start();
        try {
            $values = (static fn (string $file): mixed => require $file)($path);
        } finally {
            $output = ob_get_clean();
        }
        if ($output !== '' || !is_array($values)) {
            throw new RuntimeException('Translation files must return arrays without output.');
        }
        $value = $values;
        foreach (explode('.', $match[3]) as $key) {
            $value = is_array($value) ? $value[$key] ?? null : null;
        }
        if ($value !== null) {
            $translated[$locale] = marketText($value, $maximum);
        }
    }
    if ($translated === []) {
        throw new RuntimeException('A market translation key has no translated value.');
    }
    ksort($translated);

    return $translated;
}

try {
    if ($argc !== 3 || !preg_match('~^([A-Za-z0-9-]{1,39})/([A-Za-z0-9_.-]+)$~D', $argv[2], $repository)) {
        throw new RuntimeException('Usage: market.php <staged-package> <owner/repository>');
    }
    $directory = realpath($argv[1]);
    $owner = strtolower($repository[1]);
    if (!preg_match('/^[a-z][a-z0-9-]{1,49}$/D', $owner)) {
        $owner = 'github-'.$owner;
    }
    if (!$directory || !preg_match('/^[a-z][a-z0-9-]{1,49}$/D', $owner)) {
        throw new RuntimeException('The package directory or repository owner is invalid.');
    }
    $manifest = json_decode(file_get_contents($directory.'/manifest.json'), true, 32, JSON_THROW_ON_ERROR);
    $slug = $manifest['id'] ?? null;
    if (
        !is_string($slug) ||
        !preg_match('/^[a-z][a-z0-9-]{1,49}$/D', $slug) ||
        !in_array($manifest['type'] ?? null, ['plugin', 'theme', 'game'], true)
    ) {
        throw new RuntimeException('Invalid package market identity.');
    }
    $locales = [];
    foreach (is_dir($directory.'/lang') ? scandir($directory.'/lang') : [] as $locale) {
        if (
            strlen($locale) <= 35 &&
            preg_match('/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/D', $locale) &&
            is_dir($directory.'/lang/'.$locale)
        ) {
            $locales[] = $locale;
        }
    }
    if (count($locales) > 100) {
        throw new RuntimeException('Market translations exceed the allowed language count.');
    }
    $settings = $manifest['market'] ?? [];
    if (!is_array($settings)) {
        throw new RuntimeException('Invalid package market settings.');
    }
    $author = $settings['author'] ?? [];
    $commercial = $settings['commercial'] ?? ['kind' => 'free'];
    if (
        !is_array($author) ||
        !is_array($commercial) ||
        !in_array($commercial['kind'] ?? null, ['free', 'paid'], true)
    ) {
        throw new RuntimeException('Invalid package market settings.');
    }
    if (array_key_exists('url', $commercial)) {
        $commercial['url'] = marketUrl($commercial['url']);
    }
    if (array_key_exists('price', $commercial)) {
        $price = $commercial['price'];
        if (
            !is_array($price) ||
            !is_string($price['amount'] ?? null) ||
            !preg_match('/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/D', $price['amount']) ||
            !is_string($price['currency'] ?? null) ||
            !preg_match('/^[A-Z]{3}$/D', $price['currency'])
        ) {
            throw new RuntimeException('Market prices require a decimal amount string and an ISO currency code.');
        }
    }
    $manual = $settings['manual_only'] ?? $commercial['kind'] === 'paid';
    if (!is_bool($manual)) {
        throw new RuntimeException('The manual installation setting must be a boolean.');
    }
    $resource = [
        'id' => $owner.'/'.$slug,
        'slug' => $slug,
        'type' => $manifest['type'],
        'name' => marketTranslations(
            $settings['name'] ?? ($manifest['name'] ?? null),
            $slug,
            $directory,
            $locales,
            120,
        ),
        'description' => marketTranslations(
            $settings['description'] ?? ($manifest['description'] ?? null),
            $slug,
            $directory,
            $locales,
            1000,
        ),
        'author' => [
            'id' => $owner,
            'name' => marketText($author['name'] ?? $repository[1], 120),
            'url' => marketUrl($author['url'] ?? 'https://github.com/'.$repository[1]),
        ],
        'repository' => 'https://github.com/'.$argv[2],
        'commercial' => $commercial,
        'manual_only' => $manual,
    ];
    if (array_key_exists('image', $settings)) {
        $resource['image'] = marketValues(
            $settings['image'],
            static fn (mixed $image): string => marketImage($image, $directory, $argv[2], $manifest['version'] ?? null),
        );
    }
    echo json_encode($resource, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES).PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, 'Market metadata failed: '.$error->getMessage().PHP_EOL);
    exit(1);
}
