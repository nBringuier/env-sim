export class StringUtils {
  static kebabToPascal(value: string): string {
    return value
      .split('-')
      .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join('');
  }

  static pascalToKebab(value: string): string {
    return value
      .replaceAll(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }
}