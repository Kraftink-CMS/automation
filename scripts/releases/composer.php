<?php

use PhpParser\Node;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\ParserFactory;

[$script, $mode, $root, $prefix] = $argv;

function packageFiles(string $directory): array
{
    $files = [];
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        $relative = str_replace('\\', '/', substr($file->getPathname(), strlen($directory) + 1));
        if ($file->isLink()) {
            throw new RuntimeException('Composer libraries cannot contain symbolic links.');
        }
        if (!$file->isFile() || preg_match('~(?:^|/)\.[^/]*|^bin/~', $relative)) {
            continue;
        }
        $files[$relative] = $file->getPathname();
    }
    ksort($files);

    return $files;
}

function excludedGlobals(array $symbols): string
{
    $globals = array_values(array_filter($symbols, fn ($symbol) => !str_contains($symbol, '\\')));
    $allowed = implode('|', array_map(fn ($symbol) => preg_quote($symbol, '~'), $globals));

    return $allowed === '' ? '~^[^\\\\]+$~' : '~^(?!(?:'.$allowed.')$)[^\\\\]+$~';
}

function vendorPath(string $path, string $vendor): string
{
    $real = realpath($path);
    $base = realpath($vendor);
    if (!$real || !$base || !str_starts_with(str_replace('\\', '/', $real).'/', str_replace('\\', '/', $base).'/')) {
        throw new RuntimeException('Composer autoload paths must stay inside the extension vendor directory.');
    }

    return str_replace('\\', '/', substr($real, strlen($base) + 1));
}

if ($mode === 'metadata') {
    require $argv[4];
    $parser = (new ParserFactory())->createForNewestSupportedVersion();
    $file = $root.'/vendor/composer/InstalledVersions.php';
    $nodes = $parser->parse(file_get_contents($file));
    $method = (new PhpParser\NodeFinder())->findFirst($nodes, fn ($node) => $node instanceof Node\Stmt\ClassMethod && (string) $node->name === 'getInstalled');
    if ($method === null) {
        throw new RuntimeException('Unsupported Composer runtime metadata.');
    }
    $method->stmts = $parser->parse('<?php if (self::$installed === null) { self::$installed = require __DIR__."/installed.php"; } return [self::$installed];');
    file_put_contents($file, (new PhpParser\PrettyPrinter\Standard())->prettyPrintFile($nodes));
    exit;
}

if ($mode === 'configuration') {
    $toolAutoload = $argv[4];
    require $toolAutoload;
    $manifest = json_decode(file_get_contents($root.'/manifest.json'), true, flags: JSON_THROW_ON_ERROR);
    $inventory = new class extends NodeVisitorAbstract
    {
        public array $classes = ['Composer\\InstalledVersions'];

        public array $functions = [];

        public array $constants = [];

        public function enterNode(Node $node): null
        {
            if ($node instanceof Node\Stmt\ClassLike && $node->name !== null) {
                $this->classes[] = (string) $node->namespacedName;
            } elseif ($node instanceof Node\Stmt\Function_) {
                $this->functions[] = (string) $node->namespacedName;
            } elseif ($node instanceof Node\Stmt\Const_) {
                foreach ($node->consts as $constant) {
                    $this->constants[] = (string) $constant->namespacedName;
                }
            } elseif ($node instanceof Node\Expr\FuncCall && $node->name instanceof Node\Name && strtolower((string) $node->name) === 'define') {
                $name = $node->args[0]->value ?? null;
                if ($name instanceof Node\Scalar\String_) {
                    $this->constants[] = $name->value;
                }
            }

            return null;
        }
    };
    $parser = (new ParserFactory())->createForNewestSupportedVersion();
    $traverser = new NodeTraverser(new NameResolver(), $inventory);
    foreach (packageFiles($root.'/vendor') as $relative => $path) {
        if (!preg_match('/\.(?:php|inc)$/D', $relative) || str_starts_with($relative, 'composer/') || $relative === 'autoload.php') {
            continue;
        }
        $traverser->traverse($parser->parse(file_get_contents($path)) ?? []);
    }
    $namespaces = ['Composer'];
    foreach ([$inventory->classes, $inventory->functions, $inventory->constants] as $symbols) {
        foreach ($symbols as $symbol) {
            $position = strrpos($symbol, '\\');
            if ($position !== false) {
                $namespaces[] = substr($symbol, 0, $position);
            }
        }
    }
    $namespaces = array_values(array_unique($namespaces));
    usort($namespaces, fn ($left, $right) => strlen($left) <=> strlen($right));
    $private = [];
    foreach ($namespaces as $namespace) {
        if (!array_filter($private, fn ($parent) => $namespace === $parent || str_starts_with($namespace, $parent.'\\'))) {
            $private[] = $namespace;
        }
    }
    foreach ($private as $namespace) {
        if (in_array(explode('\\', $namespace)[0], ['App', 'Illuminate', 'Laravel'], true)) {
            throw new RuntimeException('Laravel and KraftInk host namespaces cannot be bundled as private libraries.');
        }
    }
    $pattern = implode('|', array_map(fn ($namespace) => preg_quote($namespace, '~'), $private));
    $composerClasses = array_values(array_filter($inventory->classes, fn ($class) => str_starts_with($class, 'Composer\\')));
    $composerPattern = implode('|', array_map(fn ($class) => preg_quote($class, '~'), $composerClasses));
    $configuration = [
        'prefix' => rtrim($prefix, '\\'),
        'exclude-namespaces' => ['~^(?!(?:'.$pattern.')(?:\\\\|$))(?!$).*~'],
        'exclude-classes' => [excludedGlobals($inventory->classes), '~^(?!(?:'.$composerPattern.')$)Composer\\\\~'],
        'exclude-functions' => [excludedGlobals($inventory->functions)],
        'exclude-constants' => [excludedGlobals($inventory->constants)],
        'expose-global-classes' => false,
        'expose-global-functions' => false,
        'expose-global-constants' => false,
    ];
    if (isset($manifest['namespace'])) {
        foreach (array_merge($inventory->classes, $inventory->functions, $inventory->constants) as $symbol) {
            if (str_starts_with($symbol, $manifest['namespace'])) {
                throw new RuntimeException('A private dependency cannot own the extension namespace.');
            }
        }
        $configuration['exclude-namespaces'][] = rtrim($manifest['namespace'], '\\');
    }
    $extra = is_file($root.'/scoper.inc.php') ? require $root.'/scoper.inc.php' : [];
    if (!is_array($extra) || array_diff(array_keys($extra), ['patchers'])) {
        throw new RuntimeException('Extension scoper.inc.php may configure patchers only.');
    }
    if (isset($extra['patchers']) && (!is_array($extra['patchers']) || count(array_filter($extra['patchers'], 'is_callable')) !== count($extra['patchers']))) {
        throw new RuntimeException('Invalid PHP-Scoper patchers.');
    }
    $contents = '<?php return '.var_export($configuration, true).';';
    if (isset($extra['patchers'])) {
        $contents = '<?php $configuration = '.var_export($configuration, true).'; $extra = require '.var_export($root.'/scoper.inc.php', true).'; $configuration["patchers"] = $extra["patchers"]; return $configuration;';
    }
    file_put_contents($root.'/kraftink-scoper.php', $contents);
    echo json_encode(['configuration' => $root.'/kraftink-scoper.php'], JSON_THROW_ON_ERROR);
    exit;
}

if ($mode !== 'export') {
    throw new RuntimeException('Unknown Composer build operation.');
}
$vendor = $root.'/vendor';
$metadata = ['psr4' => [], 'classmap' => [], 'files' => [], 'hashes' => [], 'platform' => []];
$author = json_decode(file_get_contents($root.'/manifest.json'), true, flags: JSON_THROW_ON_ERROR)['namespace'] ?? null;
foreach (require $vendor.'/composer/autoload_psr4.php' as $namespace => $paths) {
    if ($author !== null && $namespace === $author) {
        continue;
    }
    if (!str_starts_with($namespace, $prefix)) {
        throw new RuntimeException('A Composer autoload namespace was not isolated: '.$namespace);
    }
    $metadata['psr4'][$namespace] = array_map(fn ($path) => vendorPath($path, $vendor), $paths);
}
foreach (require $vendor.'/composer/autoload_classmap.php' as $class => $path) {
    if ($class === 'Composer\\InstalledVersions' || ($author !== null && str_starts_with($class, $author))) {
        continue;
    }
    if (!str_starts_with($class, $prefix)) {
        throw new RuntimeException('A Composer autoload class was not isolated: '.$class);
    }
    $metadata['classmap'][$class] = vendorPath($path, $vendor);
}
$metadata['classmap'][$prefix.'Composer\\InstalledVersions'] = 'composer/InstalledVersions.php';
if (is_file($vendor.'/composer/autoload_files.php')) {
    foreach (require $vendor.'/composer/autoload_files.php' as $path) {
        $metadata['files'][] = vendorPath($path, $vendor);
    }
}
$composer = json_decode(file_get_contents($root.'/composer.json'), true, flags: JSON_THROW_ON_ERROR);
$lock = json_decode(file_get_contents($root.'/composer.lock'), true, flags: JSON_THROW_ON_ERROR);
foreach ([$composer, ...$lock['packages']] as $package) {
    foreach ($package['require'] ?? [] as $name => $constraint) {
        if ($name !== 'php' && $name !== 'php-64bit' && !str_starts_with($name, 'ext-')) {
            if (!str_contains($name, '/') && $name !== 'composer-runtime-api') {
                throw new RuntimeException('Unsupported private library platform requirement: '.$name);
            }
            continue;
        }
        if (!isset($metadata['platform'][$name])) {
            $metadata['platform'][$name] = $constraint;
            continue;
        }
        $clauses = [];
        foreach (preg_split('/\s*\|\|?\s*/', $metadata['platform'][$name]) as $left) {
            foreach (preg_split('/\s*\|\|?\s*/', $constraint) as $right) {
                $clauses[] = trim($left.' '.$right);
            }
        }
        $metadata['platform'][$name] = implode(' || ', array_unique($clauses));
        if (strlen($metadata['platform'][$name]) > 2000) {
            throw new RuntimeException('Private library platform constraints are too complex.');
        }
    }
}
foreach (packageFiles($vendor) as $relative => $path) {
    if ($relative !== 'kraftink.json') {
        $metadata['hashes'][$relative] = hash_file('sha256', $path);
    }
}
foreach (['psr4', 'classmap', 'hashes', 'platform'] as $key) {
    ksort($metadata[$key]);
    $metadata[$key] = (object) $metadata[$key];
}
file_put_contents($vendor.'/kraftink.json', json_encode($metadata, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR).PHP_EOL);
echo json_encode(['files' => array_keys(packageFiles($vendor))], JSON_THROW_ON_ERROR);
