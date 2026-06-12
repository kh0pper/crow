# Programa para desarrolladores

Crow es una plataforma de IA de código abierto construida sobre el estándar [Model Context Protocol](https://modelcontextprotocol.io). Damos la bienvenida a las contribuciones de desarrolladores que quieran extender la plataforma con nuevas integraciones, skills, herramientas y bundles de despliegue.

## ¿Qué es Crow?

Crow les da a los asistentes de IA memoria persistente, gestión de proyectos con backends de datos, compartición P2P cifrada y más de 20 integraciones con servicios. Funciona con Claude, ChatGPT, Gemini, Grok, Cursor y más. Todo corre sobre estándares abiertos — sin dependencia de un proveedor.

## Cómo contribuir

### Integraciones MCP

Conecta nuevos servicios externos (Linear, Jira, Todoist, etc.) agregando una entrada de servidor MCP y un archivo de skill complementario.

→ [Crear integraciones](./integrations)

### Skills

Escribe prompts conductuales que le enseñan a la IA nuevos flujos de trabajo. Los skills son archivos markdown — no requieren código.

→ [Escribir skills](./skills)

### Herramientas de los servidores núcleo

Agrega nuevas herramientas MCP a los servidores crow-memory, crow-projects, crow-sharing, crow-storage o crow-blog.

→ [Herramientas núcleo](./core-tools)

### Capacidades de la plataforma

Conoce la infraestructura base que tus complementos pueden usar: reproductor multimedia persistente, programación de tareas, búsqueda web, almacenamiento, compartición P2P y chat de IA.

→ [Capacidades de la plataforma](./platform-capabilities)

### Bundles autoalojados

Crea configuraciones de Docker Compose con conjuntos curados de integraciones para casos de uso específicos (académico, empresarial, creativo).

→ [Bundles](./bundles)

## Inicio rápido

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
npm run setup
```

Luego elige uno de los tipos de contribución de arriba y sigue la guía.

## Entorno de desarrollo (próximamente)

Está planeado un modo de Entorno de Desarrollo: cuando esté disponible, se habilitará en el panel de Configuración y mostrará un panel de Desarrollador dedicado en el Crow's Nest con recarga en caliente para paneles y skills, un arnés de pruebas para servidores MCP, validación de manifiestos, visualización de logs de bundles y pruebas de humo para todos los tipos de complementos. También está planeada una CLI de empaquetado (`npm run package-addon`) para crear tarballs distribuibles listos para enviarse al registro.

El Entorno de Desarrollo está diseñado para agilizar el ciclo de vida completo de un complemento: generar el andamiaje, desarrollar con retroalimentación en vivo, probar, empaquetar y publicar — todo sin salir de la plataforma Crow.

## Directorio de la comunidad

Explora las contribuciones existentes de la comunidad y envía las tuyas.

→ [Directorio de la comunidad](./directory)

## Recursos

- [CONTRIBUTING.md](https://github.com/kh0pper/crow/blob/main/CONTRIBUTING.md) — Lineamientos completos para contribuidores
- [GitHub Issues](https://github.com/kh0pper/crow/issues) — Reporta errores y propone ideas
- [Documentación de arquitectura](../architecture/) — Diseño del sistema y APIs de los servidores
