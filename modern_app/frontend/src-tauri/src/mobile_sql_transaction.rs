use serde::Deserialize;
use serde_json::Value;
use tauri_plugin_sql::{DbInstances, DbPool};

#[derive(Deserialize)]
pub struct Statement {
    sql: String,
    values: Vec<Value>,
    // Optional compare-and-set assertion, checked before committing the batch.
    expected_rows: Option<u64>,
}

// Same SQLite pool and permissions as plugin-sql, but all statements share
// one transaction/connection. SQL and domain rules stay in the repository.
#[tauri::command]
pub async fn mobile_sql_transaction(
    databases: tauri::State<'_, DbInstances>,
    statements: Vec<Statement>,
) -> Result<Vec<u64>, String> {
    let message = "No se pudo completar la operación local. No se guardaron cambios.";
    if statements.is_empty() || statements.len() > 16 {
        return Err(message.into());
    }
    let pool = {
        let instances = databases.0.read().await;
        match instances.get("sqlite:scisonomics-mobile.db") {
            Some(DbPool::Sqlite(pool)) => pool.clone(),
            _ => return Err(message.into()),
        }
    };
    let mut transaction = pool.begin().await.map_err(|_| message.to_string())?;
    let mut changed = Vec::with_capacity(statements.len());
    for statement in statements {
        let mut query = sqlx::query(&statement.sql);
        for value in statement.values {
            query = match value {
                Value::Null => query.bind(None::<String>),
                Value::String(value) => query.bind(value),
                Value::Number(value) => {
                    if let Some(integer) = value.as_i64() { query.bind(integer) }
                    else if let Some(number) = value.as_f64() { query.bind(number) }
                    else { return Err(message.into()); }
                }
                Value::Bool(value) => query.bind(value),
                _ => return Err(message.into()),
            };
        }
        match query.execute(&mut *transaction).await {
            Ok(result) => {
                if statement.expected_rows.is_some_and(|expected| expected != result.rows_affected()) {
                    let _ = transaction.rollback().await;
                    return Err(message.into());
                }
                changed.push(result.rows_affected());
            }
            Err(_) => {
                let _ = transaction.rollback().await;
                return Err(message.into());
            }
        }
    }
    transaction.commit().await.map_err(|_| message.to_string())?;
    Ok(changed)
}
